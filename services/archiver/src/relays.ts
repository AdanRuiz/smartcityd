import { NOSTR_KIND, type SignedEvent } from '@smartcity/schemas'

export type Fetch = (url: string) => Promise<Response>

// Cap of `limit` in the relay's queries (docs/spec/07, "Suscripciones").
const PAGE = 1000

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
  const response = await fetch(url)
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

/** Events of a city's UTC day from a relay, following the pages of `GET /v1/export` (docs/spec/07). */
export async function fetchDay(fetch: Fetch, relay: string, city: string, day: string): Promise<SignedEvent[]> {
  const events: SignedEvent[] = []
  let cursor: string | null = null
  do {
    const params = new URLSearchParams({ c: city, day })
    if (cursor !== null) params.set('cursor', cursor)
    const lines = await ndjson(fetch, `${httpBase(relay)}/v1/export?${params}`)
    const last = lines.at(-1)
    cursor = isCursor(last) ? last.cursor : null
    for (const line of cursor === null ? lines : lines.slice(0, -1)) events.push(line as SignedEvent)
  } while (cursor !== null)
  return events
}

/**
 * Kind 5 deletion requests a relay holds with `created_at >= since`, through `GET /v1/events` (docs/spec/07),
 * paging back with `until` until a page brings nothing new. Deletions need not carry a `c` tag, so they are not
 * asked by city: the archiver only applies those whose author owns the event (SNAP-3).
 */
export async function fetchDeletions(fetch: Fetch, relay: string, since: number): Promise<SignedEvent[]> {
  const byId = new Map<string, SignedEvent>()
  let until: number | null = null
  for (;;) {
    const params = new URLSearchParams({ kinds: String(NOSTR_KIND.DELETION), since: String(since), limit: String(PAGE) })
    if (until !== null) params.set('until', String(until))
    const page = (await ndjson(fetch, `${httpBase(relay)}/v1/events?${params}`)) as SignedEvent[]
    const before = byId.size
    for (const event of page) byId.set(event.id, event)
    // A relay may cap `limit` below PAGE, so a short page does not mean the end; a page with nothing new does.
    if (page.length === 0 || byId.size === before) break
    // `until` is inclusive: events of the oldest second come again and are deduplicated.
    until = Math.min(...page.map((e) => e.created_at))
  }
  return [...byId.values()]
}
