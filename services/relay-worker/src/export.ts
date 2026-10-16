import { canonicalLine, isCityId, isHex64, utcDayRange } from '@smartcity/schemas'
import type { ExportPosition, Store } from './store.js'

// Lines per page of `GET /v1/export`, as the `limit` cap of queries (docs/spec/07, "Suscripciones").
export const EXPORT_PAGE = 1000

const CURSOR = /^(\d+)\.([0-9a-f]{64})$/
const PARAMS = new Set(['c', 'day', 'cursor'])

// Opaque to clients; here, the position of the last event sent.
function encodeCursor({ created_at, id }: ExportPosition): string {
  return `${created_at}.${id}`
}

function decodeCursor(value: string): ExportPosition | null {
  const m = CURSOR.exec(value)
  const createdAt = m ? Number(m[1]) : NaN
  return m && Number.isSafeInteger(createdAt) && isHex64(m[2]) ? { created_at: createdAt, id: m[2] } : null
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
  now: number,
  page = EXPORT_PAGE,
): Promise<{ body: string } | { error: string }> {
  for (const name of params.keys()) {
    if (name === 'received_after') return { error: 'unsupported: received_after' }
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
  const events = await store.exportRange(city, range, after, page + 1, now)
  const lines = events.slice(0, page).map((e) => canonicalLine(e) + '\n')
  const last = events[page - 1]
  if (events.length > page && last) lines.push(JSON.stringify({ cursor: encodeCursor(last) }) + '\n')
  return { body: lines.join('') }
}
