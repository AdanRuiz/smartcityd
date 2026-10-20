import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { KIND, NOSTR_KIND, SECONDS_PER_DAY, canonicalNdjson, validateEvent, type SignedEvent } from '@smartcity/schemas'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { GRACE_SECONDS, buildAddendum, buildDaily } from '../src/daily.js'
import { MAX_AGE_SECONDS, monthlyPaths, runMonthly, utcMonthRange } from '../src/monthly.js'
import type { Fetch } from '../src/relays.js'
import { paths, write } from '../src/snapshot.js'

const CITY = 'mx-gdl'
const MONTH = '2025-02'
const FROM = Date.UTC(2025, 1, 1) / 1000
const TO = Date.UTC(2025, 2, 1) / 1000
const READY = TO + MAX_AGE_SECONDS
const G = [
  ['g', '9ewm'],
  ['g', '9ewmq'],
  ['g', '9ewmqx'],
]
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const quiet = () => {}
const offline: Fetch = async () => new Response('down', { status: 503 })

const sk = generateSecretKey()
const pk = getPublicKey(sk)

function sign(kind: number, tags: string[][], content: string, createdAt: number): SignedEvent {
  return finalizeEvent({ kind, tags, content, created_at: createdAt }, sk) as SignedEvent
}

function observation(createdAt: number): SignedEvent {
  const content = JSON.stringify({ v: 1, obs: [{ ts: createdAt, values: { pm25: 12 } }] })
  return sign(KIND.OBSERVATION, [['c', CITY], ['a', `${KIND.DATASET}:${pk}:aire`], ...G], content, createdAt)
}

const dayOf = (at: number) => new Date(at * 1000).toISOString().slice(0, 10)

/** Writes the daily file of every day of the month, each with the events created that day. */
async function dailies(out: string, events: SignedEvent[]) {
  for (let from = FROM; from < TO; from += SECONDS_PER_DAY) {
    const day = dayOf(from)
    const own = events.filter((e) => dayOf(e.created_at) === day)
    const now = from + SECONDS_PER_DAY + GRACE_SECONDS
    const snapshot = buildDaily({ city: CITY, day, events: own, deletions: [], relays: ['wss://relay-a.example'], now })
    await write(paths(out, CITY, day, 0), snapshot, { out }, quiet)
  }
}

async function addendum(out: string, day: string, events: SignedEvent[], archived: string[]) {
  const now = READY - SECONDS_PER_DAY
  const input = { city: CITY, day, events, deletions: [], relays: ['wss://relay-b.example'], now }
  const snapshot = buildAddendum({ ...input, archived: new Set(archived), n: 1 })
  await write(paths(out, CITY, day, 1), snapshot, { out }, quiet)
}

describe('monthly consolidated file (SNAP-4, SNAP-9)', () => {
  it('gives the UTC range of a month, December included', () => {
    expect(utcMonthRange(MONTH)).toEqual({ from: FROM, to: TO })
    expect(utcMonthRange('2025-12')).toEqual({ from: Date.UTC(2025, 11, 1) / 1000, to: Date.UTC(2026, 0, 1) / 1000 })
    for (const bad of ['2025-13', '2025-00', '2025-2', '2025-02-01']) expect(utcMonthRange(bad)).toBeNull()
  })

  it('joins the dailies and addenda of the month into one file, torrent and snapshot event', async () => {
    const out = await mkdtemp(join(tmpdir(), 'monthly-'))
    const first = observation(FROM + 10)
    const middle = observation(FROM + 14 * SECONDS_PER_DAY + 5)
    const last = observation(TO - 1)
    await dailies(out, [first, middle, last])
    const late = observation(FROM + 20)
    await addendum(out, dayOf(FROM), [first, late], [first.id])

    const result = await runMonthly(
      { city: CITY, month: MONTH, relays: [], out, webSeeds: ['https://seed.example/m'] },
      { fetch: offline, now: READY, log: quiet },
    )
    expect(result.joined).toBe(28 + 1)
    const expected = canonicalNdjson([first, late, middle, last])
    const files = monthlyPaths(out, CITY, MONTH)
    expect(result.files).toEqual(files)
    const gzip = await readFile(files.archive)
    expect(gunzipSync(gzip).toString('utf8')).toBe(expected)

    const event = JSON.parse(await readFile(files.event, 'utf8')) as { content: string; tags: string[][] }
    expect(validateEvent({ ...event, kind: KIND.SNAPSHOT }).ok).toBe(true)
    expect(event.tags).toEqual([['c', CITY], ['t', 'monthly'], ['x', sha256(expected)]])
    const content = JSON.parse(event.content) as Record<string, unknown>
    const name = `sc_${CITY}_${MONTH}.ndjson.gz`
    expect(content).toMatchObject({
      from: FROM,
      to: TO,
      count: 4,
      x: sha256(expected),
      file: { name, x: sha256(gzip), size: gzip.length },
      urls: [`https://seed.example/m/${name}`],
      relays: ['wss://relay-a.example', 'wss://relay-b.example'],
    })
    // DIST-1 to DIST-3: the same distribution fields as a daily.
    expect(content.cid).toMatch(/^bafk/)
    expect(content.magnet).toMatch(/^magnet:\?xt=urn:btih:[0-9a-f]{40}&.*ws=/)
    expect((await readFile(files.torrent)).length).toBeGreaterThan(0)
  })

  it('waits until the last day of the month can no longer get addenda (SNAP-9)', async () => {
    const out = await mkdtemp(join(tmpdir(), 'monthly-'))
    await dailies(out, [])
    const options = { city: CITY, month: MONTH, relays: [], out }
    await expect(runMonthly(options, { fetch: offline, now: READY - 1, log: quiet })).rejects.toThrow(/SNAP-9/)
    const result = await runMonthly(options, { fetch: offline, now: READY, log: quiet })
    expect(result.snapshot.content.count).toBe(0)
  })

  it('refuses a month with a day lacking its daily file', async () => {
    const out = await mkdtemp(join(tmpdir(), 'monthly-'))
    await dailies(out, [])
    const day = dayOf(FROM + 3 * SECONDS_PER_DAY)
    await rm(paths(out, CITY, day, 0).archive)
    await expect(
      runMonthly({ city: CITY, month: MONTH, relays: [], out }, { fetch: offline, now: READY, log: quiet }),
    ).rejects.toThrow(new RegExp(`no daily file .* for ${day}`))
  })

  it('leaves out what a later deletion of its author covers, archived or from the relays (SNAP-3)', async () => {
    const out = await mkdtemp(join(tmpdir(), 'monthly-'))
    const byArchive = observation(FROM + 100)
    const byRelay = observation(FROM + 200)
    const kept = observation(FROM + 300)
    const archivedDeletion = sign(NOSTR_KIND.DELETION, [['c', CITY], ['e', byArchive.id]], '', FROM + 9 * SECONDS_PER_DAY)
    await dailies(out, [byArchive, byRelay, kept, archivedDeletion])
    const relayDeletion = sign(NOSTR_KIND.DELETION, [['e', byRelay.id]], '', TO + 5 * SECONDS_PER_DAY)
    const relay: Fetch = async (raw) => {
      const url = new URL(raw)
      if (url.pathname !== '/v1/events') return new Response('not found', { status: 404 })
      const until = Number(url.searchParams.get('until') ?? Infinity)
      return new Response(relayDeletion.created_at <= until ? JSON.stringify(relayDeletion) + '\n' : '')
    }

    const result = await runMonthly(
      { city: CITY, month: MONTH, relays: ['https://relay-c.example', 'https://down.example'], out },
      { fetch: (url, init) => (url.startsWith('https://down') ? offline(url, init) : relay(url, init)), now: READY, log: quiet },
    )
    expect(result.snapshot.ndjson).toBe(canonicalNdjson([kept, archivedDeletion]))
    expect(result.snapshot.deleted).toBe(2)
    expect(result.failed.map((f) => f.relay)).toEqual(['https://down.example'])
  })

  it('stops if a published file does not match its x, and never overwrites the consolidated file (SNAP-2, SNAP-6)', async () => {
    const out = await mkdtemp(join(tmpdir(), 'monthly-'))
    await dailies(out, [observation(FROM + 10)])
    const options = { city: CITY, month: MONTH, relays: [], out }
    const deps = { fetch: offline, now: READY, log: quiet }
    const archive = paths(out, CITY, dayOf(FROM), 0).archive
    const original = await readFile(archive)
    await writeFile(archive, gzipSync('{}\n'))
    await expect(runMonthly(options, deps)).rejects.toThrow(/does not match the x/)
    await writeFile(archive, original)
    await runMonthly(options, deps)
    await expect(runMonthly(options, deps)).rejects.toThrow(/SNAP-2/)
  })
})
