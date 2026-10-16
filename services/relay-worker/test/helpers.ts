import { KIND, NOSTR_KIND } from '@smartcity/schemas'
import { getPow } from 'nostr-tools/nip13'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { acceptEvent } from '../src/accept.js'
import { readConfig, type RelayVars } from '../src/config.js'
import type { NostrEvent } from '../src/event.js'
import { importNdjson } from '../src/import.js'
import { RateLimiter } from '../src/ratelimit.js'
import { RoleBook } from '../src/roles.js'
import { Store } from '../src/store.js'
import { sqliteDb as sqliteDbAt } from '../cli/sqlite.js'

/** D1 stand-in on node:sqlite, with the migrations of the relay applied. */
export function sqliteDb() {
  return sqliteDbAt(new URL('../migrations/', import.meta.url))
}

export const NOW = 1_760_000_000
export const CITY = 'mx-gdl'
export const G = [
  ['g', '9ewm'],
  ['g', '9ewmq'],
  ['g', '9ewmqx'],
]

export function key() {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}

export function sign(
  sk: Uint8Array,
  kind: number,
  tags: string[][],
  content: unknown,
  createdAt = NOW,
): NostrEvent {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return finalizeEvent({ kind, tags, content: text, created_at: createdAt }, sk) as NostrEvent
}

export function airDataset(pk: string) {
  return `${KIND.DATASET}:${pk}:air-quality`
}

export function observation(sk: Uint8Array, datasetOwner: string, createdAt = NOW, extraTags: string[][] = []) {
  return sign(
    sk,
    KIND.OBSERVATION,
    [['c', CITY], ['a', airDataset(datasetOwner)], ...G, ...extraTags],
    { v: 1, loc: [20.6668, -103.3918], obs: [{ ts: createdAt, values: { pm25: 18.2, temp: 24.1 } }] },
    createdAt,
  )
}

export function dataset(sk: Uint8Array, name: string, createdAt = NOW) {
  return sign(
    sk,
    KIND.DATASET,
    [
      ['d', 'air-quality'],
      ['c', '*'],
      ['t', 'ambiente'],
    ],
    {
      v: 1,
      name,
      license: 'CC0-1.0',
      mode: 'observation',
      geometry: 'point',
      fields: { pm25: { type: 'number', unit: 'ug/m3', min: 0, max: 1000 } },
    },
    createdAt,
  )
}

export function live(sk: Uint8Array, datasetOwner: string) {
  return sign(sk, KIND.LIVE, [['d', 'bus-142'], ['c', CITY], ['a', `${KIND.DATASET}:${datasetOwner}:buses`], ...G], {
    v: 1,
    ts: NOW,
    values: { route: '380', speed: 31 },
    loc: [20.6668, -103.3918],
  })
}

export function deletion(sk: Uint8Array, tags: string[][], createdAt = NOW + 10) {
  return sign(sk, NOSTR_KIND.DELETION, tags, '', createdAt)
}

/** A relay core (acceptance + store) over a fresh in-memory database. */
export function relay(vars: RelayVars = {}) {
  const { db, count, exec } = sqliteDb()
  const store = new Store(db)
  const config = readConfig(vars)
  const deps = { store, config, limiter: new RateLimiter(() => NOW * 1000), now: () => NOW, roles: new RoleBook(config.trustAnchors) }
  return {
    store,
    count,
    exec,
    publish: (event: unknown, ip = '192.0.2.1') => acceptEvent(event, ip, deps),
    /** Imports a snapshot's NDJSON (docs/spec/07, RELAY-5). */
    importNdjson: (ndjson: string) => importNdjson(ndjson, deps),
  }
}

/** A citizen report; `bits` of NIP-13 proof of work mined into its id. */
export function report(sk: Uint8Array, bits = 0, createdAt = NOW) {
  const pubkey = getPublicKey(sk)
  const tags = [['c', CITY], ['t', 'bache'], ...G]
  const content = JSON.stringify({ v: 1, title: 'Bache', loc: [20.6668, -103.3918] })
  for (let n = 0; ; n++) {
    const candidate = { kind: KIND.REPORT, tags: bits > 0 ? [...tags, ['nonce', String(n), String(bits)]] : tags, content, created_at: createdAt, pubkey }
    if (getPow(getEventHash(candidate)) >= bits) return finalizeEvent(candidate, sk) as NostrEvent
  }
}

export function roles(sk: Uint8Array, entries: [string, string][], createdAt = NOW) {
  return sign(sk, KIND.ROLES, [['d', CITY], ['c', CITY], ...entries.map(([pk, role]) => ['p', pk, role])], { v: 1 }, createdAt)
}
