import { isHex64, tagValues } from '@smartcity/schemas'
import { addressD, eventCity, type NostrEvent } from './event.js'

/** NIP-01 filter. `tags` holds the `#x` conditions keyed by letter. */
export interface Filter {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
  tags: Record<string, string[]>
}

export const MAX_LIMIT = 1000
export const MAX_SUBSCRIPTIONS = 10
export const MAX_FILTERS = 10

// Tags with their own rows in `tags`; `c` and `d` are columns of `events` (docs/spec/07).
export const INDEXED_TAGS = ['a', 'e', 'g', 'p', 't', 'x'] as const
const QUERYABLE_TAGS = new Set<string>([...INDEXED_TAGS, 'c', 'd'])

// D1 binds at most 100 parameters per statement; keep room for the fixed ones.
const MAX_FILTER_VALUES = 80

function stringList(value: unknown, test: (v: string) => boolean): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && test(v)) ? (value as string[]) : null
}

function nonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** Validates a filter received from a client. Returns the filter or the reason it is rejected. */
export function parseFilter(raw: unknown): Filter | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'filter must be an object'
  const filter: Filter = { tags: {} }
  let values = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'ids' || key === 'authors') {
      const list = stringList(value, isHex64)
      if (!list) return `${key} must be a list of 64-character hex strings`
      filter[key] = list
      values += list.length
    } else if (key === 'kinds') {
      if (!Array.isArray(value) || !value.every(nonNegativeInt)) return 'kinds must be a list of integers'
      filter.kinds = value
      values += value.length
    } else if (key === 'since' || key === 'until' || key === 'limit') {
      if (!nonNegativeInt(value)) return `${key} must be a non-negative integer`
      filter[key] = value
    } else if (key.length === 2 && key.startsWith('#')) {
      const name = key[1]!
      if (!QUERYABLE_TAGS.has(name)) return `unsupported: tag #${name} is not indexed`
      const list = stringList(value, () => true)
      if (!list) return `${key} must be a list of strings`
      filter.tags[name] = list
      values += list.length
    }
    // Other keys (NIP-50 search…) are not supported and are ignored, as most relays do.
  }
  if (values > MAX_FILTER_VALUES) return `filter has more than ${MAX_FILTER_VALUES} values`
  return filter
}

const LIST_PARAMS = ['ids', 'authors', 'kinds'] as const

/** `GET /v1/events` query string → filter (docs/spec/07, "API HTTP"). */
export function filterFromQuery(params: URLSearchParams): Filter | string {
  const raw: Record<string, unknown> = {}
  for (const [key, value] of params) {
    const list = value.split(',').filter((v) => v !== '')
    if ((LIST_PARAMS as readonly string[]).includes(key)) raw[key] = key === 'kinds' ? list.map(Number) : list
    else if (key === 'since' || key === 'until' || key === 'limit') raw[key] = Number(value)
    else if (/^[a-zA-Z]$/.test(key)) raw[`#${key}`] = list
    else return `unknown parameter: ${key}`
  }
  return parseFilter(raw)
}

/** True when a filter can match nothing (an empty list in any condition). */
export function isEmptyFilter(filter: Filter): boolean {
  const lists = [filter.ids, filter.authors, filter.kinds, ...Object.values(filter.tags)]
  return lists.some((list) => list !== undefined && list.length === 0)
}

function tagMatches(event: NostrEvent, name: string, wanted: string[]): boolean {
  const values = name === 'c' ? [eventCity(event)] : name === 'd' ? [addressD(event)] : tagValues(event.tags, name)
  return values.some((v) => v !== null && wanted.includes(v))
}

/** In-memory evaluation, used for the fan-out of new events. Same semantics as the SQL in `Store.query`. */
export function matchFilter(filter: Filter, event: NostrEvent): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.since !== undefined && event.created_at < filter.since) return false
  if (filter.until !== undefined && event.created_at > filter.until) return false
  return Object.entries(filter.tags).every(([name, wanted]) => tagMatches(event, name, wanted))
}
