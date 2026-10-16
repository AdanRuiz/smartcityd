// Canonical NDJSON of a snapshot (docs/spec/06, "Formato"). The relay's `GET /v1/export` and the archiver
// both serialize through here, so the canonical hash `x` of a day is the same on both sides.

export interface SignedEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
export const SECONDS_PER_DAY = 86_400

/** One line: JSON without spaces, keys in the order `id, pubkey, created_at, kind, tags, content, sig`. */
export function canonicalLine(event: SignedEvent): string {
  const { id, pubkey, created_at, kind, tags, content, sig } = event
  return JSON.stringify({ id, pubkey, created_at, kind, tags, content, sig })
}

/** Line order: `created_at` ascending, then `id` ascending. */
export function compareCanonical(a: SignedEvent, b: SignedEvent): number {
  return a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** The whole NDJSON (one line per event, each ending in `\n`), deduplicated by `id` and sorted. */
export function canonicalNdjson(events: readonly SignedEvent[]): string {
  const byId = new Map<string, SignedEvent>()
  for (const event of events) byId.set(event.id, event)
  return [...byId.values()]
    .sort(compareCanonical)
    .map((e) => canonicalLine(e) + '\n')
    .join('')
}

/** UTC day `YYYY-MM-DD` as the half-open range `[from, to)` in seconds; null if it is not a real date. */
export function utcDayRange(day: string): { from: number; to: number } | null {
  const m = DAY.exec(day)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (new Date(ms).toISOString().slice(0, 10) !== day) return null
  const from = ms / 1000
  return { from, to: from + SECONDS_PER_DAY }
}
