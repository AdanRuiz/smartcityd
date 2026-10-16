import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { KIND, NOSTR_KIND } from '@smartcity/schemas'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { acceptEvent } from '../src/accept.js'
import { readConfig, type RelayVars } from '../src/config.js'
import type { NostrEvent } from '../src/event.js'
import { RateLimiter } from '../src/ratelimit.js'
import { Store, type Db, type DbResult, type DbStatement } from '../src/store.js'

/** D1 stand-in on node:sqlite, with the migrations of the relay applied. */
export function sqliteDb(): { db: Db; count: (sql: string) => number } {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'))

  class Statement implements DbStatement {
    constructor(
      readonly sql: string,
      readonly values: SQLInputValue[] = [],
    ) {}
    bind(...values: unknown[]): DbStatement {
      return new Statement(this.sql, values as SQLInputValue[])
    }
    async all<T>(): Promise<DbResult<T>> {
      return { results: sqlite.prepare(this.sql).all(...this.values) as T[], meta: {} }
    }
    async first<T>(): Promise<T | null> {
      return (sqlite.prepare(this.sql).get(...this.values) as T | undefined) ?? null
    }
    async run(): Promise<DbResult> {
      return this.runSync()
    }
    runSync(): DbResult {
      return { meta: { rows_written: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }
    }
  }

  const db: Db = {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((s) => (s as Statement).runSync())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  const count = (sql: string) => Number((sqlite.prepare(sql).get() as { n: number }).n)
  return { db, count }
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
  const { db, count } = sqliteDb()
  const store = new Store(db)
  const deps = { store, config: readConfig(vars), limiter: new RateLimiter(() => NOW * 1000), now: () => NOW }
  return {
    store,
    count,
    publish: (event: unknown, ip = '192.0.2.1') => acceptEvent(event, ip, deps),
  }
}
