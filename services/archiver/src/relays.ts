import { NOSTR_KIND } from '@smartcity/schemas'

export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

// Cap of `limit` in the relay's queries (docs/spec/07, "Suscripciones").
const PAGE = 1000

/** A relay that does not answer a page in this time is given up on, so it cannot stall the archiver. */
export const REQUEST_TIMEOUT_MS = 30_000

/** HTTP base of a relay given as `wss://`, `ws://`, `https://` or `http://`. */
export function httpBase(relay: string): string {
  const url = new URL(relay)
  if (url.protocol === 'wss:') url.protocol = 'https:'
  else if (url.protocol === 'ws:') url.protocol = 'http:'
  else if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`not a relay URL: ${relay}`)
  return url.href.replace(/\/+$/, '')
}

/** `wss://` form of a relay, as the `relays` field of a snapshot lists it. */
export function wsUrl(relay: string): string {
  return httpBase(relay).replace(/^http/, 'ws')
}

async function ndjson(fetch: Fetch, url: string): Promise<unknown[]> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const text = await response.text()
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line) as unknown
      } catch {
        throw new Error(`${url}: line ${i + 1} is not JSON`)
      }
    })
}

function isCursor(value: unknown): value is { cursor: string } {
  return typeof value === 'object' && value !== null && typeof (value as { cursor?: unknown }).cursor === 'string'
}

/**
 * Lines of a city's UTC day from a relay, following the pages of `GET /v1/export` (docs/spec/07). They are
 * unchecked relay data: `buildDaily` verifies each one. A cursor that comes back twice fails the relay instead of
 * looping forever.
 */
export async function fetchDay(fetch: Fetch, relay: string, city: string, day: string): Promise<unknown[]> {
  const events: unknown[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const params = new URLSearchParams({ c: city, day })
    if (cursor !== null) params.set('cursor', cursor)
    const lines = await ndjson(fetch, `${httpBase(relay)}/v1/export?${params}`)
    const last = lines.at(-1)
    cursor = isCursor(last) ? last.cursor : null
    if (cursor !== null) {
      if (cursors.has(cursor)) throw new Error(`${relay}: export cursor ${cursor} repeats`)
      cursors.add(cursor)
    }
    events.push(...(cursor === null ? lines : lines.slice(0, -1)))
  } while (cursor !== null)
  return events
}

/** What paging needs from a line; the full check is done by `buildDaily`. */
function isPageable(value: unknown): value is { id: string; created_at: number } {
  if (typeof value !== 'object' || value === null) return false
  const e = value as { id?: unknown; created_at?: unknown }
  return typeof e.id === 'string' && Number.isSafeInteger(e.created_at)
}

/**
 * Kind 5 deletion requests a relay holds with `created_at >= since`, through `GET /v1/events` (docs/spec/07),
 * paging back with `until`. Deletions need not carry a `c` tag, so they are not asked by city: the archiver only
 * applies those whose author owns the event (SNAP-3). Lines are unchecked relay data, verified by `buildDaily`.
 *
 * `until` is inclusive, so the oldest second of a page comes again and is deduplicated. If a whole page shares
 * one second, more deletions of that second than the relay returns per page cannot be reached with `until`
 * alone: `warn` reports it and paging goes on from the second before, so older deletions are not lost.
 */
export async function fetchDeletions(
  fetch: Fetch,
  relay: string,
  since: number,
  warn: (line: string) => void = () => {},
): Promise<unknown[]> {
  const byId = new Map<string, unknown>()
  let until: number | null = null
  let fullPage = 0 // largest page seen: the relay's real cap on `limit`
  for (;;) {
    const params = new URLSearchParams({ kinds: String(NOSTR_KIND.DELETION), since: String(since), limit: String(PAGE) })
    if (until !== null) params.set('until', String(until))
    const page = (await ndjson(fetch, `${httpBase(relay)}/v1/events?${params}`)).filter(isPageable)
    if (page.length === 0) break
    fullPage = Math.max(fullPage, page.length)
    let fresh = 0
    for (const event of page) {
      if (byId.has(event.id)) continue
      byId.set(event.id, event)
      fresh++
    }
    const oldest = page.reduce((min, e) => Math.min(min, e.created_at), Infinity)
    // A relay may cap `limit` below PAGE, so a short page does not mean the end; only an empty one does.
    if (fresh > 0) until = oldest
    else if (until !== null && oldest === until) {
      // Only a full page of one second can hide more of it; a short one is just the tail of the previous page.
      if (page.length >= fullPage) warn(`${relay}: deletions at ${until} may exceed one page; some may be missing`)
      until -= 1
    } else break // the relay ignored `until`: nothing more to learn from it
    if (until < since) break
  }
  return [...byId.values()]
}
