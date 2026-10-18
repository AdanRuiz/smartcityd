import { readFileSync } from 'node:fs'
import { KIND } from '@smartcity/schemas'
import * as nostrPure from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/config.js'
import type { NostrEvent } from '../src/event.js'
import { handleHttp } from '../src/http.js'
import { RateLimiter } from '../src/ratelimit.js'
import { Store } from '../src/store.js'
import { CITY, sqliteDb } from './helpers.js'

// The public guide for third parties (GOAL-1) has to work as written: its script runs here, unchanged, against the
// HTTP API of this relay, one instance per relay URL of the guide.
const GUIDE = readFileSync(new URL('../../../docs/desarrolladores/primer-dataset.md', import.meta.url), 'utf8')
const MARKER = 'services/relay-worker/test/guide.test.ts'
// Geohash of the guide's [20.6668, -103.3918] at precision 4, 5 and 6, as the SDK's encodeGeohash gives it (EVT-3).
const G = [
  ['g', '9ewm'],
  ['g', '9ewmx'],
  ['g', '9ewmx6'],
]

/** The fenced `js` block right after the comment that names this test. */
function guideScript(): string {
  const at = GUIDE.indexOf(MARKER)
  expect(at).toBeGreaterThan(0)
  const block = /```js\n([\s\S]*?)\n```/.exec(GUIDE.slice(at))
  expect(block).not.toBeNull()
  return block![1]!
}

// The guide may only use the public library: any other import fails the test.
const MODULES: Record<string, unknown> = { 'nostr-tools/pure': nostrPure }

type Script = (modules: Record<string, unknown>, fetch: typeof globalThis.fetch, console: { log: (...args: unknown[]) => void }) => Promise<void>

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

    await compile(guideScript())(MODULES, fetchStub, { log: (...args) => logged.push(args) })

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
