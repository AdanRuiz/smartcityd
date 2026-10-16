import { KIND, NOSTR_KIND, ROLES, parseAddress, tagValues, type Role, type SourceContent } from '@smartcity/schemas'
import { wins, type NostrEvent } from './event.js'

export type TrustLevel = 'verified' | 'community' | 'flagged'
export const TRUST_LEVELS: readonly TrustLevel[] = ['verified', 'community', 'flagged']

/** What the level of something depends on: who signed it, which event, and for readings, which source. */
export interface Signed {
  id: string
  pubkey: string
  /** Address of the source (`31482:<owner>:<d>`), for observations. */
  source?: string
}

/**
 * Trust as seen by one client (docs/spec/04). Built from the `roles` lists signed by its anchors (TRUST-4), the
 * `keys` of the sources it has seen, and the labels and reports of moderators. Never stored in an event nor decided
 * by a relay (TRUST-7): it is recomputed whenever anchors or lists change.
 */
export class TrustState {
  private anchors: string[]
  /** Winning `roles` list of each anchor (DATA-3). */
  private readonly lists = new Map<string, NostrEvent>()
  private roles = new Map<string, Set<Role>>()
  /** Winning `source` definition of each address: the device keys its owner lists (ID-5). */
  private readonly sources = new Map<string, NostrEvent>()
  private readonly moderation = new Map<string, NostrEvent>()
  private flaggedEvents = new Set<string>()
  private flaggedKeys = new Set<string>()

  constructor(
    anchors: string[],
    private readonly cityId: string,
  ) {
    this.anchors = [...new Set(anchors)]
  }

  getAnchors(): string[] {
    return [...this.anchors]
  }

  /** TRUST-10: attestations of anchors no longer trusted stop counting at once. */
  setAnchors(anchors: string[]): void {
    this.anchors = [...new Set(anchors)]
    for (const pubkey of [...this.lists.keys()]) if (!this.anchors.includes(pubkey)) this.lists.delete(pubkey)
    this.recompute()
  }

  /** Feeds an event that may change trust. Returns true if something changed. */
  learn(event: NostrEvent): boolean {
    if (event.kind === KIND.ROLES) {
      if (!this.anchors.includes(event.pubkey) || tagValues(event.tags, 'd')[0] !== this.cityId) return false
      const current = this.lists.get(event.pubkey)
      if (current && !wins(event, current)) return false
      this.lists.set(event.pubkey, event)
      this.recompute()
      return true
    }
    if (event.kind === KIND.SOURCE) {
      const key = `${event.kind}:${event.pubkey}:${tagValues(event.tags, 'd')[0] ?? ''}`
      const current = this.sources.get(key)
      if (current && !wins(event, current)) return false
      this.sources.set(key, event)
      return true
    }
    if (event.kind === NOSTR_KIND.LABEL || event.kind === NOSTR_KIND.ABUSE_REPORT) {
      if (this.moderation.has(event.id)) return false
      this.moderation.set(event.id, event)
      return this.recomputeModeration()
    }
    return false
  }

  /** Roles attested to a key by the anchors. Anchors define the city, so they count as `authority`. */
  rolesOf(pubkey: string): Role[] {
    const roles = new Set(this.roles.get(pubkey))
    if (this.anchors.includes(pubkey)) roles.add('authority')
    return ROLES.filter((r) => roles.has(r))
  }

  hasRole(pubkey: string, ...roles: Role[]): boolean {
    const own = this.rolesOf(pubkey)
    return !own.includes('blocked') && roles.some((r) => own.includes(r))
  }

  /** Keys with a role other than `blocked`. */
  isAttested(pubkey: string): boolean {
    const own = this.rolesOf(pubkey)
    return own.length > 0 && !own.includes('blocked')
  }

  /** Levels of docs/spec/04: `flagged` beats everything; then `verified`; otherwise `community`. */
  levelOf(item: Signed): TrustLevel {
    if (this.rolesOf(item.pubkey).includes('blocked')) return 'flagged'
    if (this.flaggedEvents.has(item.id) || this.flaggedKeys.has(item.pubkey)) return 'flagged'
    if (this.isAttested(item.pubkey)) return 'verified'
    if (item.source) {
      const a = parseAddress(item.source)
      if (a && a.kind === KIND.SOURCE && this.isAttested(a.pubkey)) {
        if (item.pubkey === a.pubkey) return 'verified'
        const def = this.sources.get(item.source)
        const keys = def ? ((JSON.parse(def.content) as SourceContent).keys ?? []) : []
        if (keys.includes(item.pubkey)) return 'verified'
      }
    }
    return 'community'
  }

  /** Keys holding `moderator`, whose labels and reports hide content. */
  moderators(): string[] {
    return [...this.roles.entries()].filter(([pk]) => this.hasRole(pk, 'moderator')).map(([pk]) => pk)
  }

  /** Every key some anchor gave a role, with its roles. For the app to show who is who. */
  attested(): { pubkey: string; roles: Role[] }[] {
    return [...this.roles.keys()].map((pubkey) => ({ pubkey, roles: this.rolesOf(pubkey) }))
  }

  private recompute(): void {
    const roles = new Map<string, Set<Role>>()
    for (const list of this.lists.values()) {
      for (const tag of list.tags) {
        if (tag[0] !== 'p' || !tag[1] || !(ROLES as readonly string[]).includes(tag[2] ?? '')) continue
        let set = roles.get(tag[1])
        if (!set) roles.set(tag[1], (set = new Set()))
        set.add(tag[2] as Role)
      }
    }
    this.roles = roles
    this.recomputeModeration()
  }

  /**
   * `08`, moderation: a label (1985) or a report (1984) from a moderator hides what it points at. A report about a key
   * alone (`p` without `e`) hides that key.
   */
  private recomputeModeration(): boolean {
    const events = new Set<string>()
    const keys = new Set<string>()
    for (const m of this.moderation.values()) {
      if (!this.hasRole(m.pubkey, 'moderator')) continue
      const e = tagValues(m.tags, 'e')
      e.forEach((id) => events.add(id))
      if (e.length === 0) tagValues(m.tags, 'p').forEach((pk) => keys.add(pk))
    }
    const changed = !sameSet(events, this.flaggedEvents) || !sameSet(keys, this.flaggedKeys)
    this.flaggedEvents = events
    this.flaggedKeys = keys
    return changed
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v))
}
