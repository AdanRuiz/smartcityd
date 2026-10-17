import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  KIND,
  NOSTR_KIND,
  canonicalLine,
  canonicalNdjson,
  compareCanonical,
  validateEvent,
  type SignedEvent,
} from '@smartcity/schemas'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { GRACE_SECONDS, buildDaily } from '../src/daily.js'
import { fetchDay, fetchDeletions, httpBase, type Fetch } from '../src/relays.js'
import { runSnapshot } from '../src/snapshot.js'

const CITY = 'mx-gdl'
const DAY = '2025-10-09'
const FROM = 1_759_968_000
const TO = FROM + 86_400
const AFTER_GRACE = TO + GRACE_SECONDS
const G = [
  ['g', '9ewm'],
  ['g', '9ewmq'],
  ['g', '9ewmqx'],
]
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

function key() {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}

function sign(sk: Uint8Array, kind: number, tags: string[][], content: unknown, createdAt: number): SignedEvent {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return finalizeEvent({ kind, tags, content: text, created_at: createdAt }, sk) as SignedEvent
}

function observation(sk: Uint8Array, pk: string, createdAt: number, extra: string[][] = []) {
  return sign(sk, KIND.OBSERVATION, [['c', CITY], ['a', `${KIND.DATASET}:${pk}:aire`], ...G, ...extra], {
    v: 1,
    obs: [{ ts: createdAt, values: { pm25: 12 } }],
  }, createdAt)
}

function source(sk: Uint8Array, pk: string, d: string, createdAt: number) {
  return sign(sk, KIND.SOURCE, [['d', d], ['c', CITY], ['a', `${KIND.DATASET}:${pk}:aire`]], {
    v: 1,
    name: 'Azotea',
    status: 'active',
  }, createdAt)
}

const deletion = (sk: Uint8Array, tags: string[][], createdAt: number) => sign(sk, NOSTR_KIND.DELETION, tags, '', createdAt)

/** Relays over `fetch`, as the reference relay answers `GET /v1/export` by day and `GET /v1/events?kinds=5`. */
function relays(stores: Record<string, SignedEvent[]>, exportPage = 2, eventsPage = 1000): Fetch {
  return async (raw) => {
    const url = new URL(raw)
    const events = stores[url.origin]
    if (!events) return new Response('down', { status: 503 })
    const lines: string[] = []
    if (url.pathname === '/v1/export') {
      const after = url.searchParams.get('cursor')
      const sorted = events
        .filter((e) => e.created_at >= FROM && e.created_at < TO && e.kind !== NOSTR_KIND.DELETION)
        .sort(compareCanonical)
      const start = after ? sorted.findIndex((e) => `${e.created_at}.${e.id}` === after) + 1 : 0
      const page = sorted.slice(start, start + exportPage)
      lines.push(...page.map(canonicalLine))
      const last = page.at(-1)
      if (start + exportPage < sorted.length && last) lines.push(JSON.stringify({ cursor: `${last.created_at}.${last.id}` }))
    } else if (url.pathname === '/v1/events') {
      const since = Number(url.searchParams.get('since'))
      const until = Number(url.searchParams.get('until') ?? Infinity)
      const found = events
        .filter((e) => e.kind === NOSTR_KIND.DELETION && e.created_at >= since && e.created_at <= until)
        .sort((a, b) => b.created_at - a.created_at)
      lines.push(...found.slice(0, Math.min(eventsPage, Number(url.searchParams.get('limit')))).map((e) => JSON.stringify(e)))
    } else {
      return new Response('not found', { status: 404 })
    }
    return new Response(lines.map((l) => l + '\n').join(''))
  }
}

describe('daily file (docs/spec/06, "Formato")', () => {
  it('joins the events of every relay, deduplicated, into the canonical NDJSON (SNAP-5, DATA-6)', () => {
    const { sk, pk } = key()
    const a = [observation(sk, pk, FROM + 10), observation(sk, pk, FROM + 20)]
    const b = [a[1]!, observation(sk, pk, FROM + 5)]
    const daily = buildDaily({ city: CITY, day: DAY, events: [...a, ...b], deletions: [], relays: [], now: AFTER_GRACE })
    const expected = canonicalNdjson([...a, ...b])
    expect(daily.ndjson).toBe(expected)
    expect(daily.content.count).toBe(3)
    expect(daily.content.x).toBe(sha256(expected))
    expect(gunzipSync(daily.gzip).toString('utf8')).toBe(expected)
    expect(daily.content.file).toEqual({ name: `sc_${CITY}_${DAY}.ndjson.gz`, x: sha256(daily.gzip), size: daily.gzip.length })
    expect([daily.content.from, daily.content.to]).toEqual([FROM, TO])
  })

  it('refuses a day inside the 48 h grace period (SNAP-1)', () => {
    const input = { city: CITY, day: DAY, events: [], deletions: [], relays: [] }
    expect(() => buildDaily({ ...input, now: AFTER_GRACE - 1 })).toThrow(/SNAP-1/)
    expect(buildDaily({ ...input, now: AFTER_GRACE }).content.count).toBe(0)
  })

  it('leaves out, and reports, events with a bad signature or outside the city, the day or the archived kinds (SNAP-6)', () => {
    const { sk, pk } = key()
    const good = observation(sk, pk, FROM + 1)
    const forged = { ...observation(sk, pk, FROM + 2), content: '{"v":1,"obs":[]}' }
    const otherCity = sign(sk, KIND.OBSERVATION, [['c', 'mx-mty'], ['a', `${KIND.DATASET}:${pk}:aire`], ...G], {
      v: 1,
      obs: [{ ts: FROM, values: { pm25: 1 } }],
    }, FROM + 3)
    const previousDay = observation(sk, pk, FROM - 1)
    const replaceable = sign(sk, 10002, [['c', CITY], ['r', 'wss://relay.example']], '', FROM + 4)
    const expired = observation(sk, pk, FROM + 5, [['expiration', String(FROM + 60)]])
    const badSchema = sign(sk, KIND.OBSERVATION, [['c', CITY]], { v: 1, obs: [] }, FROM + 6)
    const events = [good, forged, otherCity, previousDay, replaceable, expired, badSchema]
    const daily = buildDaily({ city: CITY, day: DAY, events, deletions: [], relays: [], now: AFTER_GRACE })
    expect(daily.ndjson).toBe(canonicalLine(good) + '\n')
    expect(daily.discarded.map((d) => d.id).sort()).toEqual(events.slice(1).map((e) => e.id).sort())
    expect(daily.discarded.find((d) => d.id === forged.id)?.reason).toMatch(/signature/)
  })

  it('omits events their author asked to delete, by id and by address (SNAP-3, DATA-8)', () => {
    const { sk, pk } = key()
    const other = key()
    const byId = observation(sk, pk, FROM + 1)
    const notOwned = observation(sk, pk, FROM + 2)
    const oldVersion = source(sk, pk, 'azotea', FROM + 3)
    const newer = source(sk, pk, 'azotea-2', FROM + 50)
    const kept = observation(sk, pk, FROM + 4)
    const deletions = [
      deletion(sk, [['e', byId.id], ['a', `${KIND.SOURCE}:${pk}:azotea`], ['a', `${KIND.SOURCE}:${pk}:azotea-2`]], FROM + 10),
      deletion(other.sk, [['e', notOwned.id]], FROM + 11), // another key cannot delete it
    ]
    const events = [byId, notOwned, oldVersion, newer, kept]
    const daily = buildDaily({ city: CITY, day: DAY, events, deletions, relays: [], now: AFTER_GRACE })
    expect(daily.ndjson).toBe(canonicalNdjson([notOwned, newer, kept])) // `newer` is after the deletion's date
    expect(daily.deleted).toBe(2)
    expect(daily.content.policy).toBe('none')
  })

  it('gives a snapshot event that validates against its schema and tags (EVT-7)', () => {
    const { sk, pk } = key()
    const daily = buildDaily({
      city: CITY,
      day: DAY,
      events: [observation(sk, pk, FROM)],
      deletions: [],
      relays: ['wss://relay-a.example'],
      now: AFTER_GRACE,
    })
    expect(daily.template.kind).toBe(KIND.SNAPSHOT)
    expect(daily.template.tags).toEqual([['c', CITY], ['t', 'daily'], ['x', daily.content.x]])
    expect(validateEvent(daily.template).ok).toBe(true)
    expect(daily.content.relays).toEqual(['wss://relay-a.example'])
  })
})

describe('reading relays (docs/spec/07)', () => {
  it('maps relay URLs to their HTTP base', () => {
    expect(httpBase('wss://relay.example/')).toBe('https://relay.example')
    expect(httpBase('ws://localhost:8787')).toBe('http://localhost:8787')
    expect(() => httpBase('ftp://relay.example')).toThrow()
  })

  it('follows the export cursor until the last page', async () => {
    const { sk, pk } = key()
    const events = [0, 1, 2, 3, 4].map((i) => observation(sk, pk, FROM + i))
    const day = await fetchDay(relays({ 'https://a.example': events }), 'wss://a.example', CITY, DAY)
    expect(canonicalNdjson(day)).toBe(canonicalNdjson(events))
    expect(day).toHaveLength(5)
  })

  it('pages deletions back with until', async () => {
    const { sk } = key()
    const deletions = [0, 1, 2, 3, 4].map((i) => deletion(sk, [['e', 'a'.repeat(63) + i]], FROM + i))
    const fetch = relays({ 'https://a.example': deletions }, 2, 2)
    const found = await fetchDeletions(fetch, 'https://a.example', FROM)
    expect(found.map((e) => e.id).sort()).toEqual(deletions.map((e) => e.id).sort())
  })
})

describe('archiver snapshot', () => {
  it('writes the .ndjson.gz and the snapshot event from two relays, one with a deletion the other missed', async () => {
    const { sk, pk } = key()
    const shared = observation(sk, pk, FROM + 1)
    const deleted = observation(sk, pk, FROM + 2)
    const onlyB = observation(sk, pk, FROM + 3)
    const fetch = relays({
      'https://a.example': [shared, deleted, deletion(sk, [['e', deleted.id]], TO + 100)],
      'https://b.example': [shared, deleted, onlyB],
    })
    const out = await mkdtemp(join(tmpdir(), 'archiver-'))
    const logs: string[] = []
    const result = await runSnapshot(
      { city: CITY, day: DAY, relays: ['wss://a.example', 'wss://b.example', 'wss://down.example'], out },
      { fetch, now: AFTER_GRACE, log: (line) => logs.push(line) },
    )
    const expected = canonicalNdjson([shared, onlyB])
    const archive = await readFile(result.files.archive)
    expect(result.files.archive).toBe(join(out, `sc_${CITY}_${DAY}.ndjson.gz`))
    expect(gunzipSync(archive).toString('utf8')).toBe(expected)
    const event = JSON.parse(await readFile(result.files.event, 'utf8')) as SignedEvent
    const content = JSON.parse(event.content) as { x: string; count: number; relays: string[]; file: { x: string } }
    expect(content.x).toBe(sha256(expected))
    expect(content.file.x).toBe(sha256(archive))
    expect(content.count).toBe(2)
    expect(content.relays).toEqual(['wss://a.example', 'wss://b.example'])
    expect(result.failed.map((f) => f.relay)).toEqual(['wss://down.example'])
    expect(logs.some((l) => l.includes('down.example') && l.includes('skipped'))).toBe(true)
  })

  it('does not ask the relays for a day inside the grace period (SNAP-1)', async () => {
    const asked: string[] = []
    const fetch: Fetch = async (url) => (asked.push(url), new Response(''))
    const options = { city: CITY, day: DAY, relays: ['wss://a.example'], out: tmpdir() }
    await expect(runSnapshot(options, { fetch, now: AFTER_GRACE - 1, log: () => {} })).rejects.toThrow(/SNAP-1/)
    expect(asked).toEqual([])
  })

  it('writes nothing when no relay can be read', async () => {
    const out = join(await mkdtemp(join(tmpdir(), 'archiver-')), 'none')
    await expect(
      runSnapshot({ city: CITY, day: DAY, relays: ['wss://down.example'], out }, { fetch: relays({}), now: AFTER_GRACE, log: () => {} }),
    ).rejects.toThrow(/no relay/)
    await expect(readFile(join(out, `sc_${CITY}_${DAY}.ndjson.gz`))).rejects.toThrow()
  })
})
