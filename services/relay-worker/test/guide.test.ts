import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { KIND, NOSTR_KIND } from '@smartcity/schemas'
import * as nostrPure from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/config.js'
import type { NostrEvent } from '../src/event.js'
import { exportDay } from '../src/export.js'
import { handleHttp } from '../src/http.js'
import { RateLimiter } from '../src/ratelimit.js'
import { Store } from '../src/store.js'
import { CITY, airDataset, deletion, key, observation, relay, sign, sqliteDb } from './helpers.js'

// The public guides for third parties (GOAL-1) have to work as written: their scripts run here, unchanged, against
// the HTTP API of this relay, one instance per relay URL of the guide. Line ends as written, whatever git checks out.
const guide = (name: string) =>
  readFileSync(new URL(`../../../docs/desarrolladores/${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const GUIDE = guide('primer-dataset.md')
const HISTORY = guide('historial.md')
const MARKER = 'services/relay-worker/test/guide.test.ts'
// Geohash of the guide's [20.6668, -103.3918] at precision 4, 5 and 6, as the SDK's encodeGeohash gives it (EVT-3).
const G = [
  ['g', '9ewm'],
  ['g', '9ewmx'],
  ['g', '9ewmx6'],
]

/** The fenced `js` block right after the comment that names this test. */
function guideScript(text = GUIDE): string {
  const at = text.indexOf(MARKER)
  expect(at).toBeGreaterThan(0)
  const block = /```js\n([\s\S]*?)\n```/.exec(text.slice(at))
  expect(block).not.toBeNull()
  return block![1]!
}

// The guide may only use the public library: any other import fails the test.
const MODULES: Record<string, unknown> = { 'nostr-tools/pure': nostrPure }

type Log = (...args: unknown[]) => void
type Script = (modules: Record<string, unknown>, fetch: typeof globalThis.fetch, console: { log: Log; warn: Log }) => Promise<void>

function compile(code: string): Script {
  const body = code.replace(/^import \{([^}]+)\} from '([^']+)'$/gm, (_line, names: string, from: string) => {
    if (!(from in MODULES)) throw new Error(`the guide imports ${from}`)
    return `const {${names}} = __modules[${JSON.stringify(from)}]`
  })
  expect(body).not.toMatch(/^import /m)
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => Script
  return new AsyncFunction('__modules', 'fetch', 'console', body)
}

function relayAt() {
  const { db } = sqliteDb()
  const store = new Store(db)
  const broadcasts: NostrEvent[] = []
  const deps = {
    store,
    config: readConfig({}),
    limiter: new RateLimiter(),
    now: () => Math.floor(Date.now() / 1000),
    broadcast: (result: { event: NostrEvent }) => void broadcasts.push(result.event),
  }
  return { store, broadcasts, handle: (request: Request) => handleHttp(request, deps) }
}

describe('docs/desarrolladores/primer-dataset.md (GOAL-1)', () => {
  it('defines a new dataset, publishes to both relays and reads the reading back, verified and once', async () => {
    const relays = new Map<string, ReturnType<typeof relayAt>>()
    const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      const host = new URL(request.url).host
      if (!relays.has(host)) relays.set(host, relayAt())
      const response = await relays.get(host)!.handle(request)
      if (!response) throw new Error(`not an HTTP route: ${request.url}`)
      return response
    }) as typeof globalThis.fetch
    const logged: unknown[][] = []

    await compile(guideScript())(MODULES, fetchStub, { log: (...args) => logged.push(args), warn: () => {} })

    expect(relays.size).toBe(2)
    for (const { store, broadcasts } of relays.values()) {
      const stored = await store.query({ tags: {} }, Math.floor(Date.now() / 1000))
      expect(stored.map((e) => e.kind).sort()).toEqual([KIND.OBSERVATION, KIND.DATASET, KIND.SOURCE].sort())
      expect(broadcasts).toHaveLength(3)
      const [dataset, source, observation] = [KIND.DATASET, KIND.SOURCE, KIND.OBSERVATION].map(
        (kind) => stored.find((e) => e.kind === kind)!,
      )
      const address = `${KIND.DATASET}:${dataset!.pubkey}:ruido`
      expect(dataset!.tags).toContainEqual(['c', CITY])
      expect(source!.tags).toEqual(expect.arrayContaining([['a', address], ...G]))
      expect(observation!.tags).toEqual(
        expect.arrayContaining([['c', CITY], ['a', address], ['a', `${KIND.SOURCE}:${dataset!.pubkey}:balcon-01`], ...G]),
      )
    }
    // One line per reading, deduplicated across the two relays.
    expect(logged).toHaveLength(1)
    expect(logged[0]![0]).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(logged[0]![1]).toEqual({ laeq: 54.3 })
  })

  it('names the kinds that packages/schemas assigns', () => {
    const table = Object.fromEntries(
      [...GUIDE.matchAll(/^\| `(\w+)` \| (\d+) \|/gm)].map(([, name, kind]) => [name!, Number(kind)]),
    )
    expect(table).toEqual({ dataset: KIND.DATASET, source: KIND.SOURCE, observation: KIND.OBSERVATION })
    expect(guideScript()).toContain(
      `const KIND = { observation: ${KIND.OBSERVATION}, dataset: ${KIND.DATASET}, source: ${KIND.SOURCE} }`,
    )
  })
})

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
// The guide's DAY, the day before the helpers' NOW, so the helpers' relay takes its events.
const DAY = '2025-10-08'
const START = Date.UTC(2025, 9, 8) / 1000
const DAY_SECONDS = 86_400

/** The canonical NDJSON of DAY with these events, as a relay exports it for the archiver (docs/spec/06). */
async function canonicalDay(events: NostrEvent[]): Promise<string> {
  const archive = relay({ MAX_EVENT_AGE_DAYS: '0' })
  for (const event of events) expect((await archive.publish(event)).ok).toBe(true)
  const result = await exportDay(archive.store, new URLSearchParams({ c: CITY, day: DAY }))
  if ('error' in result) throw new Error(result.error)
  return result.body
}

/** A file of DAY and its signed `snapshot` event, served from `<base>/<name>` for every base (DIST-3). */
function announce(sk: Uint8Array, type: 'daily' | 'addendum', name: string, ndjson: string, bases: string[], from = START) {
  const gzip = gzipSync(ndjson)
  const event = sign(
    sk,
    KIND.SNAPSHOT,
    [['c', CITY], ['t', type], ['x', sha256(ndjson)]],
    {
      v: 1,
      from,
      to: from + DAY_SECONDS,
      count: ndjson.trimEnd().split('\n').length,
      format: 'ndjson+gzip',
      x: sha256(ndjson),
      file: { name, x: sha256(gzip), size: gzip.length },
      urls: bases.map((base) => `${base}/${name}`),
      policy: 'none',
    },
    Math.floor(Date.now() / 1000),
  )
  return { event, gzip, name }
}

describe('docs/desarrolladores/historial.md (GOAL-1, SNAP-6)', () => {
  it('reads an archived day from its daily and addendum: verified, joined by id and with late deletions applied', async () => {
    const archiver = key()
    const { sk, pk } = key()
    const [early, kept, deleted, tampered] = [3600, 7200, 10_800, 14_400].map((at) => observation(sk, pk, START + at))
    const late = observation(sk, pk, START + 5000)
    // A line whose content no longer matches its id: the file is intact, the event is not (SNAP-6).
    const daily = (await canonicalDay([early!, kept!, deleted!, tampered!]))
      .split('\n')
      .map((line) => (line.includes(tampered!.id) ? line.replace('18.2', '99.9') : line))
      .join('\n')
    expect(daily).toContain('99.9')
    const addendum = await canonicalDay([late, deletion(sk, [['e', deleted!.id], ['c', CITY]], START + 20_000)])

    const files = [
      announce(archiver.sk, 'daily', `sc_${CITY}_${DAY}.ndjson.gz`, daily, ['https://roto.example', 'https://archivo.example']),
      announce(archiver.sk, 'addendum', `sc_${CITY}_${DAY}_a1.ndjson.gz`, addendum, ['https://archivo.example']),
      // Another day: not read.
      announce(archiver.sk, 'daily', `sc_${CITY}_2025-10-07.ndjson.gz`, addendum, ['https://archivo.example'], START - DAY_SECONDS),
    ]
    const served = new Map(files.map(({ name, gzip }) => [`/${name}`, gzip]))

    const script = guideScript(HISTORY)
    const hosts = [.../const RELAYS = \[([^\]]+)\]/.exec(script)![1]!.matchAll(/'https:\/\/([^']+)'/g)].map(([, host]) => host!)
    expect(hosts).toHaveLength(2)
    const relays = new Map(hosts.map((host) => [host, relayAt()]))
    const post = async (host: string, event: NostrEvent) => {
      const response = await relays.get(host)!.handle(
        new Request(`https://${host}/v1/events`, { method: 'POST', body: JSON.stringify(event) }),
      )
      expect(await response!.json()).toMatchObject({ ok: true })
    }
    // The daily on both relays, the addendum on one: the script joins what each relay knows.
    for (const host of hosts) await post(host, files[0]!.event)
    await post(hosts[1]!, files[1]!.event)
    await post(hosts[0]!, files[2]!.event)

    const fetched: string[] = []
    const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const relayed = relays.get(url.host)
      if (relayed) return (await relayed.handle(request))!
      fetched.push(url.href)
      if (url.host === 'roto.example') return new Response('not the file')
      const file = url.host === 'archivo.example' ? served.get(url.pathname) : undefined
      return file ? new Response(file) : new Response('not found', { status: 404 })
    }) as typeof globalThis.fetch
    const logged: unknown[][] = []
    const warned: unknown[][] = []

    await compile(script)(MODULES, fetchStub, { log: (...args) => logged.push(args), warn: (...args) => warned.push(args) })

    // A damaged copy falls through to the next URL; the other day's file is never asked for.
    expect(fetched.sort()).toEqual(
      [
        `https://roto.example/${files[0]!.name}`,
        `https://archivo.example/${files[0]!.name}`,
        `https://archivo.example/${files[1]!.name}`,
      ].sort(),
    )
    const reading = (event: NostrEvent) => [
      new Date(event.created_at * 1000).toISOString(),
      airDataset(pk),
      { pm25: 18.2, temp: 24.1 },
    ]
    expect(logged).toEqual([early!, late, kept!].map(reading))
    expect(warned).toEqual([['1 eventos inválidos descartados']])
  })

  it('names the kinds that packages/schemas assigns', () => {
    expect(guideScript(HISTORY)).toContain(
      `const KIND = { deletion: ${NOSTR_KIND.DELETION}, observation: ${KIND.OBSERVATION}, snapshot: ${KIND.SNAPSHOT}, dataset: ${KIND.DATASET} }`,
    )
    expect(HISTORY).toContain(`evento \`snapshot\` (kind ${KIND.SNAPSHOT})`)
  })
})
