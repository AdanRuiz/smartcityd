import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { KIND, NOSTR_KIND, canonicalLine, canonicalNdjson, compareCanonical, type SignedEvent } from '@smartcity/schemas'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { GRACE_SECONDS } from '../src/daily.js'
import { cursorPath, runLate } from '../src/late.js'
import { fetchReceived, type Fetch } from '../src/relays.js'
import { runSnapshot } from '../src/snapshot.js'

const CITY = 'mx-gdl'
const DAY = '2025-10-09'
const FROM = 1_759_968_000
const TO = FROM + 86_400
const NEXT_DAY = '2025-10-10'
const AFTER_GRACE = TO + 86_400 + GRACE_SECONDS // past the grace period of DAY and NEXT_DAY

const sk = generateSecretKey()
const pk = getPublicKey(sk)

function observation(createdAt: number): SignedEvent {
  const tags = [['c', CITY], ['a', `${KIND.DATASET}:${pk}:aire`], ['g', '9ewm'], ['g', '9ewmq'], ['g', '9ewmqx']]
  const content = JSON.stringify({ v: 1, obs: [{ ts: createdAt, values: { pm25: 12 } }] })
  return finalizeEvent({ kind: KIND.OBSERVATION, tags, content, created_at: createdAt }, sk) as SignedEvent
}

const deletion = (target: SignedEvent, createdAt: number) =>
  finalizeEvent({ kind: NOSTR_KIND.DELETION, tags: [['e', target.id]], content: '', created_at: createdAt }, sk) as SignedEvent

/**
 * Relays over `fetch` as the reference relay answers them: `received_after` in order of receipt (each store keeps
 * the order its events arrived) with the cursor line always last, the export of a day, and kind 5 by `since`.
 * `asked` collects every URL, to check which routes the archiver uses.
 */
function relays(stores: Record<string, SignedEvent[]>, asked: string[] = [], page = 1000, routeless = new Set<string>()): Fetch {
  return async (raw) => {
    asked.push(raw)
    const url = new URL(raw)
    const events = stores[url.origin]
    if (!events) return new Response('down', { status: 503 })
    const exported = events.filter((e) => e.kind !== NOSTR_KIND.DELETION || e.tags.some((t) => t[0] === 'c'))
    const lines: string[] = []
    if (url.pathname === '/v1/export' && url.searchParams.has('received_after')) {
      if (routeless.has(url.origin)) return new Response('{"ok":false,"reason":"unsupported: received_after"}', { status: 400 })
      const after = url.searchParams.get('received_after')!
      const start = after === '0' ? 0 : Number(after)
      const slice = exported.slice(start, start + page)
      lines.push(...slice.map(canonicalLine), JSON.stringify({ cursor: String(start + slice.length || after) }))
    } else if (url.pathname === '/v1/export') {
      const day = url.searchParams.get('day')!
      lines.push(...exported.filter((e) => new Date(e.created_at * 1000).toISOString().startsWith(day)).sort(compareCanonical).map(canonicalLine))
    } else if (url.pathname === '/v1/events') {
      const since = Number(url.searchParams.get('since'))
      const until = Number(url.searchParams.get('until') ?? Infinity)
      lines.push(...events.filter((e) => e.kind === NOSTR_KIND.DELETION && e.created_at >= since && e.created_at <= until).map((e) => JSON.stringify(e)))
    } else {
      return new Response('not found', { status: 404 })
    }
    return new Response(lines.map((l) => l + '\n').join(''))
  }
}

describe('reading relays by order of receipt (SNAP-8, docs/spec/07)', () => {
  it('follows received_after pages until a short one and returns the cursor to ask from next time', async () => {
    const events = [0, 1, 2, 3, 4].map((i) => observation(FROM + i))
    const asked: string[] = []
    const first = await fetchReceived(relays({ 'https://a.example': events }, asked, 2), 'wss://a.example', CITY, '0')
    expect(first.events).toHaveLength(5)
    expect(first.cursor).toBe('5')
    const again = await fetchReceived(relays({ 'https://a.example': events }, asked, 2), 'wss://a.example', CITY, first.cursor)
    expect(again).toEqual({ events: [], cursor: '5' })
    expect(asked.every((u) => u.includes('received_after=') && !u.includes('day='))).toBe(true)
  })

  it('fails a relay without the route or without the cursor line', async () => {
    const fetch = relays({ 'https://a.example': [] }, [], 1000, new Set(['https://a.example']))
    await expect(fetchReceived(fetch, 'wss://a.example', CITY, '0')).rejects.toThrow(/HTTP 400/)
    const noCursor: Fetch = async () => new Response(canonicalLine(observation(FROM)) + '\n')
    await expect(fetchReceived(noCursor, 'wss://a.example', CITY, '0')).rejects.toThrow(/cursor/)
  })
})

describe('archiver late (SNAP-8)', () => {
  it('writes an addendum with late events of an archived day, without asking for that day again', async () => {
    const first = observation(FROM + 1)
    const store = { 'https://a.example': [first], 'https://b.example': [first] }
    const out = await mkdtemp(join(tmpdir(), 'archiver-late-'))
    const options = { city: CITY, relays: ['wss://a.example', 'wss://b.example'], out }
    await runSnapshot({ ...options, day: DAY }, { fetch: relays(store), now: AFTER_GRACE, log: () => {} })

    // The first run starts from the beginning: everything is already in the daily, so no addendum.
    const asked: string[] = []
    const none = await runLate(options, { fetch: relays(store, asked), now: AFTER_GRACE + 60, log: () => {} })
    expect(none.addenda).toEqual([])
    expect(none.cursors).toEqual({ 'wss://a.example': '1', 'wss://b.example': '1' })
    expect(JSON.parse(await readFile(cursorPath(out, CITY), 'utf8'))).toEqual(none.cursors)

    // An offline client syncs an event of DAY, to relay a only; b gets a new event of a day not yet archived.
    const late = observation(FROM + 2)
    const unarchived = observation(TO + 5)
    store['https://a.example'].push(late)
    store['https://b.example'].push(unarchived)
    asked.length = 0
    const logs: string[] = []
    const result = await runLate(options, { fetch: relays(store, asked), now: AFTER_GRACE + 3600, log: (l) => logs.push(l) })
    expect(result.addenda.map((a) => a.day)).toEqual([DAY])
    const addendum = result.addenda[0]!
    expect(addendum.files.archive).toBe(join(out, `sc_${CITY}_${DAY}_a1.ndjson.gz`))
    expect(gunzipSync(await readFile(addendum.files.archive)).toString('utf8')).toBe(canonicalLine(late) + '\n')
    const event = JSON.parse(await readFile(addendum.files.event, 'utf8')) as SignedEvent
    expect(event.tags).toContainEqual(['t', 'addendum'])
    expect(JSON.parse(event.content)).toMatchObject({ from: FROM, to: TO, count: 1, relays: ['wss://a.example', 'wss://b.example'] })
    // Only what was received since the cursors: no export of a day.
    for (const origin of ['https://a.example', 'https://b.example']) {
      expect(asked.find((u) => u.startsWith(`${origin}/v1/export`))).toContain('received_after=1')
    }
    expect(asked.some((u) => u.includes('day='))).toBe(false)
    expect(logs.some((l) => l.includes(NEXT_DAY) && l.includes('archiver snapshot'))).toBe(true)
    expect(result.cursors).toEqual({ 'wss://a.example': '2', 'wss://b.example': '2' })

    // Nothing new: nothing written, and a2 does not exist.
    const idle = await runLate(options, { fetch: relays(store), now: AFTER_GRACE + 7200, log: () => {} })
    expect(idle.addenda).toEqual([])
    await expect(readFile(join(out, `sc_${CITY}_${DAY}_a2.ndjson.gz`))).rejects.toThrow()
  })

  it('applies deletions known by any relay, also those without c, and archives no duplicate (SNAP-3, SNAP-5)', async () => {
    const out = await mkdtemp(join(tmpdir(), 'archiver-late-'))
    const options = { city: CITY, relays: ['wss://a.example', 'wss://b.example'], out }
    const a = [observation(FROM + 1)]
    const b: SignedEvent[] = []
    const store = { 'https://a.example': a, 'https://b.example': b }
    await runSnapshot({ ...options, day: DAY }, { fetch: relays(store), now: AFTER_GRACE, log: () => {} })
    await runLate(options, { fetch: relays(store), now: AFTER_GRACE + 60, log: () => {} })

    const kept = observation(FROM + 3)
    const deleted = observation(FROM + 4)
    a.push(kept, deleted)
    b.push(kept, deletion(deleted, AFTER_GRACE + 100)) // b got the deletion, not a
    const result = await runLate(options, { fetch: relays(store), now: AFTER_GRACE + 3600, log: () => {} })
    expect(result.addenda[0]!.snapshot.ndjson).toBe(canonicalNdjson([kept]))
    expect(result.addenda[0]!.snapshot.deleted).toBe(1)
  })

  it('keeps the cursor of a relay that fails, and asks it again from there next run', async () => {
    const out = await mkdtemp(join(tmpdir(), 'archiver-late-'))
    const options = { city: CITY, relays: ['wss://a.example', 'wss://b.example'], out }
    const late = observation(FROM + 2)
    const store: Record<string, SignedEvent[]> = { 'https://a.example': [observation(FROM + 1)], 'https://b.example': [late] }
    await runSnapshot({ ...options, day: DAY, relays: ['wss://a.example'] }, { fetch: relays(store), now: AFTER_GRACE, log: () => {} })
    await writeFile(cursorPath(out, CITY), JSON.stringify({ 'wss://a.example': '1' }))

    const down = relays(store, [], 1000, new Set(['https://b.example']))
    const first = await runLate(options, { fetch: down, now: AFTER_GRACE + 60, log: () => {} })
    expect(first.failed.map((f) => f.relay)).toEqual(['wss://b.example'])
    expect(first.addenda).toEqual([])
    expect(first.cursors).toEqual({ 'wss://a.example': '1' })

    const second = await runLate(options, { fetch: relays(store), now: AFTER_GRACE + 120, log: () => {} })
    expect(second.addenda[0]!.snapshot.ndjson).toBe(canonicalLine(late) + '\n')
    expect(second.cursors).toEqual({ 'wss://a.example': '1', 'wss://b.example': '1' })
  })

  it('writes nothing and keeps the cursors when no relay can be read, and refuses a broken cursor file', async () => {
    const out = await mkdtemp(join(tmpdir(), 'archiver-late-'))
    const options = { city: CITY, relays: ['wss://down.example'], out }
    await expect(runLate(options, { fetch: relays({}), now: AFTER_GRACE, log: () => {} })).rejects.toThrow(/no relay/)
    await expect(readFile(cursorPath(out, CITY))).rejects.toThrow()
    await writeFile(cursorPath(out, CITY), '["0"]')
    await expect(runLate(options, { fetch: relays({}), now: AFTER_GRACE, log: () => {} })).rejects.toThrow(/cursor/)
  })
})
