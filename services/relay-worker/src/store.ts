import { ANY_CITY, NOSTR_KIND, SECONDS_PER_DAY, kindClass, parseAddress, tagValues, isHex64 } from '@smartcity/schemas'
import { addressD, eventCity, expiration, wins, type NostrEvent } from './event.js'
import { INDEXED_TAGS, MAX_LIMIT, isEmptyFilter, type Filter } from './filter.js'

// The subset of D1 the store uses. D1Database satisfies it; tests use node:sqlite behind the same shape.
export interface DbResult<T = unknown> {
  results?: T[]
  meta?: { rows_written?: number; rows_read?: number }
}
export interface DbStatement {
  bind(...values: unknown[]): DbStatement
  all<T = unknown>(): Promise<DbResult<T>>
  first<T = unknown>(): Promise<T | null>
  run(): Promise<DbResult>
}
export interface Db {
  prepare(sql: string): DbStatement
  batch(statements: DbStatement[]): Promise<DbResult[]>
}

export type SaveStatus =
  | 'stored' // new row
  | 'replaced' // addressable that won DATA-3 over the stored one
  | 'stale' // addressable that lost DATA-3: discarded, answered as duplicate
  | 'duplicate' // lost a race against the same id or address
  | 'ephemeral' // not stored

export interface SaveResult {
  status: SaveStatus
  rowsWritten: number
}

interface EventRow {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string
  content: string
  sig: string
}

const INDEXED = new Set<string>(INDEXED_TAGS)
const COLUMNS = 'id, pubkey, created_at, kind, tags, content, sig'

function toEvent(row: EventRow): NostrEvent {
  return { ...row, tags: JSON.parse(row.tags) as string[][] }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

/** Tags of an event that go in the `tags` table, once each. */
function indexedTags(event: NostrEvent): [string, string][] {
  const pairs = new Map<string, [string, string]>()
  for (const [name, value] of event.tags) {
    if (name && INDEXED.has(name) && value !== undefined) pairs.set(`${name}\0${value}`, [name, value])
  }
  return [...pairs.values()]
}

function rowsWritten(results: DbResult[]): number {
  return results.reduce((sum, r) => sum + (r.meta?.rows_written ?? 0), 0)
}

/** Last line of an export page: the next page starts strictly after it. */
export interface ExportPosition {
  created_at: number
  id: string
}

export class Store {
  constructor(private readonly db: Db) {}

  async exists(id: string): Promise<boolean> {
    return (await this.db.prepare('SELECT 1 AS found FROM events WHERE id = ?').bind(id).first()) !== null
  }

  /** Stores an already accepted event (docs/spec/07, "Después"). `now` in seconds. */
  async save(event: NostrEvent, now: number): Promise<SaveResult> {
    if (kindClass(event.kind) === 'ephemeral') return { status: 'ephemeral', rowsWritten: 0 }

    const statements: DbStatement[] = []
    const d = addressD(event)
    let replacing = false
    if (d !== null) {
      const current = await this.db
        .prepare('SELECT id, created_at FROM events WHERE kind = ? AND pubkey = ? AND d = ?')
        .bind(event.kind, event.pubkey, d)
        .first<{ id: string; created_at: number }>()
      if (current) {
        if (!wins(event, current)) return { status: 'stale', rowsWritten: 0 }
        statements.push(...this.deleteById(current.id))
        replacing = true
      }
    }
    if (event.kind === NOSTR_KIND.DELETION) statements.push(...this.deletionTargets(event))

    // RELAY-2: the event and its tags in a single batch.
    statements.push(this.insertEvent('INSERT', event, d, now))
    for (const [name, value] of indexedTags(event)) {
      statements.push(
        this.db
          .prepare('INSERT INTO tags (name, value, created_at, kind, event_id) VALUES (?, ?, ?, ?, ?)')
          .bind(name, value, event.created_at, event.kind, event.id),
      )
    }

    try {
      const results = await this.db.batch(statements)
      return { status: replacing ? 'replaced' : 'stored', rowsWritten: rowsWritten(results) }
    } catch (error) {
      // Same id or same address stored by a concurrent request between the check and the batch.
      if (String(error).includes('UNIQUE')) return { status: 'duplicate', rowsWritten: 0 }
      throw error
    }
  }

  /**
   * Statements that bring an event imported from a snapshot into a database, whatever it already holds: they
   * read nothing first and are idempotent, so they can also be written to a SQL file for `wrangler d1 execute`.
   * An addressable deletes the stored versions it beats (DATA-3) and is ignored if a winner is stored; tags go in
   * only with their event; a kind 5 deletes as in `save`, so deletions go after the events they refer to.
   * `receivedAt` in seconds.
   */
  importStatements(event: NostrEvent, receivedAt: number): DbStatement[] {
    if (kindClass(event.kind) === 'ephemeral') return []
    const statements: DbStatement[] = []
    const d = addressD(event)
    if (d !== null) {
      const beaten =
        'SELECT id FROM events WHERE kind = ? AND pubkey = ? AND d = ? AND (created_at < ? OR (created_at = ? AND id > ?))'
      const args = [event.kind, event.pubkey, d, event.created_at, event.created_at, event.id]
      statements.push(
        this.db.prepare(`DELETE FROM tags WHERE event_id IN (${beaten})`).bind(...args),
        this.db.prepare(`DELETE FROM events WHERE id IN (${beaten})`).bind(...args),
      )
    }
    if (event.kind === NOSTR_KIND.DELETION) statements.push(...this.deletionTargets(event))
    statements.push(this.insertEvent('INSERT OR IGNORE', event, d, receivedAt))
    for (const [name, value] of indexedTags(event)) {
      statements.push(
        this.db
          .prepare(
            'INSERT OR IGNORE INTO tags (name, value, created_at, kind, event_id) ' +
              'SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)',
          )
          .bind(name, value, event.created_at, event.kind, event.id, event.id),
      )
    }
    return statements
  }

  private insertEvent(verb: 'INSERT' | 'INSERT OR IGNORE', event: NostrEvent, d: string | null, receivedAt: number) {
    return this.db
      .prepare(
        `${verb} INTO events (id, pubkey, created_at, kind, d, city, tags, content, sig, expires_at, received_at) ` +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        d,
        eventCity(event),
        JSON.stringify(event.tags),
        event.content,
        event.sig,
        expiration(event),
        receivedAt,
      )
  }

  private deleteById(id: string): DbStatement[] {
    return [
      this.db.prepare('DELETE FROM tags WHERE event_id = ?').bind(id),
      this.db.prepare('DELETE FROM events WHERE id = ?').bind(id),
    ]
  }

  // DATA-8 / NIP-09: only the author's own events, never other deletions, addresses up to the request's date.
  private deletionTargets(deletion: NostrEvent): DbStatement[] {
    const statements: DbStatement[] = []
    for (const id of tagValues(deletion.tags, 'e').filter(isHex64)) {
      const owned = 'SELECT id FROM events WHERE id = ? AND pubkey = ? AND kind <> ?'
      const args = [id, deletion.pubkey, NOSTR_KIND.DELETION]
      statements.push(
        this.db.prepare(`DELETE FROM tags WHERE event_id IN (${owned})`).bind(...args),
        this.db.prepare(`DELETE FROM events WHERE id IN (${owned})`).bind(...args),
      )
    }
    for (const value of tagValues(deletion.tags, 'a')) {
      const address = parseAddress(value)
      if (!address || address.pubkey !== deletion.pubkey) continue
      const owned = 'SELECT id FROM events WHERE kind = ? AND pubkey = ? AND d = ? AND created_at <= ?'
      const args = [address.kind, address.pubkey, address.d, deletion.created_at]
      statements.push(
        this.db.prepare(`DELETE FROM tags WHERE event_id IN (${owned})`).bind(...args),
        this.db.prepare(`DELETE FROM events WHERE id IN (${owned})`).bind(...args),
      )
    }
    return statements
  }

  /** Stored events matching a filter, newest first (docs/spec/07, "Suscripciones"). `now` in seconds. */
  async query(filter: Filter, now: number): Promise<NostrEvent[]> {
    const limit = Math.min(filter.limit ?? MAX_LIMIT, MAX_LIMIT)
    if (limit === 0 || isEmptyFilter(filter)) return []

    const where = ['(expires_at IS NULL OR expires_at > ?)']
    const args: unknown[] = [now]
    const inList = (column: string, values: readonly unknown[]) => {
      where.push(`${column} IN (${placeholders(values.length)})`)
      args.push(...values)
    }
    if (filter.ids) inList('id', filter.ids)
    if (filter.authors) inList('pubkey', filter.authors)
    if (filter.kinds) inList('kind', filter.kinds)
    if (filter.since !== undefined) {
      where.push('created_at >= ?')
      args.push(filter.since)
    }
    if (filter.until !== undefined) {
      where.push('created_at <= ?')
      args.push(filter.until)
    }
    for (const [name, values] of Object.entries(filter.tags)) {
      if (name === 'c') inList('city', values)
      else if (name === 'd') inList('d', values)
      else {
        // An IN subquery lets SQLite drive the query from the `tags` primary key when the tag is the most
        // selective condition, which is usually the case for `a` and `g`.
        const time = [
          ...(filter.since !== undefined ? [' AND created_at >= ?'] : []),
          ...(filter.until !== undefined ? [' AND created_at <= ?'] : []),
        ].join('')
        where.push(
          `id IN (SELECT event_id FROM tags WHERE name = ? AND value IN (${placeholders(values.length)})${time})`,
        )
        args.push(name, ...values)
        if (filter.since !== undefined) args.push(filter.since)
        if (filter.until !== undefined) args.push(filter.until)
      }
    }
    args.push(limit)
    const sql = `SELECT ${COLUMNS} FROM events WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id ASC LIMIT ?`
    const { results } = await this.db.prepare(sql).bind(...args).all<EventRow>()
    return (results ?? []).map(toEvent)
  }

  /**
   * Events of a city (`c` equal to it or to `*`) with `created_at` in `[from, to)`, regular and addressable
   * only, in canonical order (docs/spec/06), strictly after `after`. `now` in seconds.
   */
  async exportRange(
    city: string,
    range: { from: number; to: number },
    after: ExportPosition | null,
    limit: number,
    now: number,
  ): Promise<NostrEvent[]> {
    const where = [
      'city IN (?, ?)',
      'created_at >= ?',
      'created_at < ?',
      // Replaceable and ephemeral kinds are not archived (NIP-01 ranges, as in kindClass).
      'NOT (kind IN (0, 3) OR (kind >= 10000 AND kind < 30000))',
      '(expires_at IS NULL OR expires_at > ?)',
    ]
    const args: unknown[] = [city, ANY_CITY, range.from, range.to, now]
    if (after) {
      where.push('(created_at > ? OR (created_at = ? AND id > ?))')
      args.push(after.created_at, after.created_at, after.id)
    }
    args.push(limit)
    const sql = `SELECT ${COLUMNS} FROM events WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT ?`
    const { results } = await this.db.prepare(sql).bind(...args).all<EventRow>()
    return (results ?? []).map(toEvent)
  }

  /** Number of events `exportRange` would return for the whole range: what a snapshot of it must count. */
  async countRange(city: string, range: { from: number; to: number }, now: number): Promise<number> {
    const row = await this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM events WHERE city IN (?, ?) AND created_at >= ? AND created_at < ? ' +
          'AND NOT (kind IN (0, 3) OR (kind >= 10000 AND kind < 30000)) AND (expires_at IS NULL OR expires_at > ?)',
      )
      .bind(city, ANY_CITY, range.from, range.to, now)
      .first<{ n: number }>()
    return Number(row?.n ?? 0)
  }

  /** Deletes events whose NIP-40 expiration has passed. Returns rows written. */
  async deleteExpired(now: number): Promise<number> {
    const expired = 'SELECT id FROM events WHERE expires_at IS NOT NULL AND expires_at <= ?'
    return rowsWritten(
      await this.db.batch([
        this.db.prepare(`DELETE FROM tags WHERE event_id IN (${expired})`).bind(now),
        this.db.prepare(`DELETE FROM events WHERE id IN (${expired})`).bind(now),
      ]),
    )
  }

  /**
   * UTC days (start, in seconds) of a city that still hold purgeable events (regular, not in `keep`) entirely
   * before `before`. Events of `*` or without a city are never listed: no single city's snapshot accounts for them.
   */
  async purgeableDays(
    before: number,
    keep: readonly number[],
    limit: number,
  ): Promise<{ city: string; day: number }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT city, (created_at / ${SECONDS_PER_DAY}) * ${SECONDS_PER_DAY} AS day FROM events ` +
          `WHERE city IS NOT NULL AND city <> ? AND created_at < ? AND ${REGULAR_SQL} ` +
          `AND kind NOT IN (${placeholders(keep.length)}) ORDER BY day ASC, city ASC LIMIT ?`,
      )
      .bind(ANY_CITY, before, ...keep, limit)
      .all<{ city: string; day: number }>()
    return (results ?? []).map((r) => ({ city: r.city, day: Number(r.day) }))
  }

  /** Deletes the purgeable events (as in `purgeableDays`) of one city in `[from, to)`. Returns rows written. */
  async deleteRegularRange(
    city: string,
    range: { from: number; to: number },
    keep: readonly number[],
  ): Promise<number> {
    const target =
      `SELECT id FROM events WHERE city = ? AND created_at >= ? AND created_at < ? AND ${REGULAR_SQL} ` +
      `AND kind NOT IN (${placeholders(keep.length)})`
    const args = [city, range.from, range.to, ...keep]
    return rowsWritten(
      await this.db.batch([
        this.db.prepare(`DELETE FROM tags WHERE event_id IN (${target})`).bind(...args),
        this.db.prepare(`DELETE FROM events WHERE id IN (${target})`).bind(...args),
      ]),
    )
  }
}

// Regular kinds (NIP-01 ranges, as in kindClass): neither replaceable, ephemeral nor addressable.
const REGULAR_SQL = 'kind NOT IN (0, 3) AND kind < 10000'

/** Runs several filters (one REQ) and merges them: deduplicated by id, newest first. */
export async function queryAll(store: Store, filters: Filter[], now: number): Promise<NostrEvent[]> {
  const byId = new Map<string, NostrEvent>()
  for (const filter of filters) for (const event of await store.query(filter, now)) byId.set(event.id, event)
  return [...byId.values()].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
}
