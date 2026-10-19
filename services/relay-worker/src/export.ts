import { canonicalLine, isCityId, isHex64, utcDayRange } from '@smartcity/schemas'
import type { ExportPosition, ReceivedPosition, Store } from './store.js'

// Lines per page of `GET /v1/export`, as the `limit` cap of queries (docs/spec/07, "Suscripciones").
export const EXPORT_PAGE = 1000

/**
 * `received_after` only gives events received at least this many seconds ago. `received_at` is taken when a
 * request starts and written once the event is verified, with a resolution of one second: an event can still land
 * behind a recent position after that position was handed out, never behind one this old.
 */
export const RECEIVED_SETTLE_SECONDS = 60

/** `received_after` value that starts from the first event the relay holds. */
export const RECEIVED_START = '0'

const CURSOR = /^(\d+)\.([0-9a-f]{64})$/
const PARAMS = new Set(['c', 'day', 'cursor'])
const RECEIVED_PARAMS = new Set(['c', 'received_after'])

// Opaque to clients; here, the position of the last event sent.
function encodeCursor({ created_at, id }: ExportPosition): string {
  return `${created_at}.${id}`
}

function decodeCursor(value: string): ExportPosition | null {
  const m = CURSOR.exec(value)
  const createdAt = m ? Number(m[1]) : NaN
  return m && Number.isSafeInteger(createdAt) && isHex64(m[2]) ? { created_at: createdAt, id: m[2] } : null
}

// Same shape for `received_after`, with the receipt time in place of `created_at`.
function encodeReceived({ received_at, id }: ReceivedPosition): string {
  return `${received_at}.${id}`
}

function decodeReceived(value: string): ReceivedPosition | null {
  const position = decodeCursor(value)
  return position && { received_at: position.created_at, id: position.id }
}

/** `GET /v1/export` (docs/spec/07): by day, or in order of receipt with `received_after`. `now` in seconds. */
export function exportEvents(
  store: Store,
  params: URLSearchParams,
  now: number,
  page = EXPORT_PAGE,
): Promise<{ body: string } | { error: string }> {
  return params.has('received_after') ? exportReceived(store, params, now, page) : exportDay(store, params, page)
}

/**
 * `GET /v1/export?c=<city>&day=<YYYY-MM-DD>[&cursor=…]` (docs/spec/07): the canonical NDJSON of the day
 * (docs/spec/06). When the day does not fit in one page, the last line is `{"cursor":"…"}` and the next page
 * is asked with that cursor; the pages without their cursor lines, concatenated, are the canonical NDJSON.
 * Returns the body, or the reason the request is invalid.
 */
export async function exportDay(
  store: Store,
  params: URLSearchParams,
  page = EXPORT_PAGE,
): Promise<{ body: string } | { error: string }> {
  for (const name of params.keys()) {
    if (!PARAMS.has(name)) return { error: `unknown parameter: ${name}` }
  }
  const city = params.get('c')
  if (!isCityId(city)) return { error: 'c must be a city id' }
  const range = utcDayRange(params.get('day') ?? '')
  if (!range) return { error: 'day must be a UTC date YYYY-MM-DD' }
  const cursor = params.get('cursor')
  const after = cursor === null ? null : decodeCursor(cursor)
  if (cursor !== null && !after) return { error: 'invalid cursor' }

  // One extra row tells whether another page follows.
  const events = await store.exportRange(city, range, after, page + 1)
  const lines = events.slice(0, page).map((e) => canonicalLine(e) + '\n')
  const last = events[page - 1]
  if (events.length > page && last) lines.push(JSON.stringify({ cursor: encodeCursor(last) }) + '\n')
  return { body: lines.join('') }
}

/**
 * `GET /v1/export?c=<city>&received_after=<cursor>` (docs/spec/07, SNAP-8): the events `exportDay` gives for the
 * city, of any day, in the order the relay received them, one canonical line each, so that the archiver finds
 * late events without asking again for days already archived. The last line is always `{"cursor":"…"}`, to ask
 * from there next time; a page with fewer than `page` events means there is nothing more for now. The first
 * request uses `RECEIVED_START`. Returns the body, or the reason the request is invalid.
 */
export async function exportReceived(
  store: Store,
  params: URLSearchParams,
  now: number,
  page = EXPORT_PAGE,
): Promise<{ body: string } | { error: string }> {
  for (const name of params.keys()) {
    if (!RECEIVED_PARAMS.has(name)) return { error: `unknown parameter with received_after: ${name}` }
  }
  const city = params.get('c')
  if (!isCityId(city)) return { error: 'c must be a city id' }
  const cursor = params.get('received_after') ?? ''
  const after = cursor === RECEIVED_START ? null : decodeReceived(cursor)
  if (cursor !== RECEIVED_START && !after) return { error: 'invalid cursor' }

  const rows = await store.exportReceived(city, after, now - RECEIVED_SETTLE_SECONDS, page)
  const lines = rows.map(({ event }) => canonicalLine(event) + '\n')
  const last = rows.at(-1)
  const next = last ? encodeReceived({ received_at: last.received_at, id: last.event.id }) : cursor
  lines.push(JSON.stringify({ cursor: next }) + '\n')
  return { body: lines.join('') }
}
