import { KIND, tagValues } from '@smartcity/schemas'
import type { NostrEvent } from './event.js'
import type { Filter } from './relay.js'

/** NIP-01 matching. A relay may ignore conditions it does not index, so the client checks again. */
export function matches(f: Filter, event: NostrEvent): boolean {
  if (f.ids && !f.ids.includes(event.id)) return false
  if (f.authors && !f.authors.includes(event.pubkey)) return false
  if (f.kinds && !f.kinds.includes(event.kind)) return false
  if (f.since !== undefined && event.created_at < f.since) return false
  if (f.until !== undefined && event.created_at > f.until) return false
  for (const [key, wanted] of Object.entries(f)) {
    if (!key.startsWith('#') || !Array.isArray(wanted)) continue
    const name = key.slice(1)
    // A city carries its id in `d`; relays answer `#c` with it (docs/spec/07).
    const values = tagValues(event.tags, name === 'c' && event.kind === KIND.CITY ? 'd' : name)
    if (!values.some((v) => (wanted as string[]).includes(v))) return false
  }
  return true
}

export function matchesAny(filters: Filter[], event: NostrEvent): boolean {
  return filters.some((f) => matches(f, event))
}
