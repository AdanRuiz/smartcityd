import { KIND, ROLES, tagValues, type Role } from '@smartcity/schemas'
import { wins, type NostrEvent } from './event.js'
import type { Store } from './store.js'

/** How long the roles of a city are reused before reading them again from D1. */
export const ROLES_TTL_SECONDS = 60

interface Cached {
  at: number
  roles: Map<string, Set<Role>>
}

/**
 * Roles attested by the operator's `TRUST_ANCHORS` (docs/spec/04, TRUST-4), for proof of work and `WRITE_POLICY=roles`.
 * Read from the relay's own store: the anchors' `roles` lists are events like any other. Anchors count as having a
 * role. Cached for a minute per city; an accepted list from an anchor drops the cache.
 */
export class RoleBook {
  private readonly cache = new Map<string, Cached>()

  constructor(private readonly anchors: readonly string[]) {}

  /** Roles of a key in a city; with `city` null, in any city the anchors list. */
  async rolesOf(pubkey: string, city: string | null, store: Store, now: number): Promise<Set<Role>> {
    const roles = new Set<Role>((await this.load(city, store, now)).get(pubkey))
    if (this.anchors.includes(pubkey)) roles.add('authority')
    return roles
  }

  /** A key with a role other than `blocked`. */
  async isAttested(pubkey: string, city: string | null, store: Store, now: number): Promise<boolean> {
    const roles = await this.rolesOf(pubkey, city, store, now)
    return roles.size > 0 && !roles.has('blocked')
  }

  /** Call after storing an event: a new list from an anchor replaces what was cached. */
  saw(event: NostrEvent): void {
    if (event.kind === KIND.ROLES && this.anchors.includes(event.pubkey)) this.cache.clear()
  }

  private async load(city: string | null, store: Store, now: number): Promise<Map<string, Set<Role>>> {
    const key = city ?? '*'
    const cached = this.cache.get(key)
    if (cached && now - cached.at < ROLES_TTL_SECONDS) return cached.roles
    const roles = new Map<string, Set<Role>>()
    if (this.anchors.length > 0) {
      const lists = await store.query(
        { kinds: [KIND.ROLES], authors: [...this.anchors], tags: city ? { d: [city] } : {} },
        now,
      )
      // One list per anchor and city (DATA-3); the store keeps only the winner, but be sure.
      const winners = new Map<string, NostrEvent>()
      for (const list of lists) {
        const k = `${list.pubkey}:${tagValues(list.tags, 'd')[0] ?? ''}`
        const current = winners.get(k)
        if (!current || wins(list, current)) winners.set(k, list)
      }
      for (const list of winners.values()) {
        for (const tag of list.tags) {
          if (tag[0] !== 'p' || !tag[1] || !(ROLES as readonly string[]).includes(tag[2] ?? '')) continue
          let set = roles.get(tag[1])
          if (!set) roles.set(tag[1], (set = new Set()))
          set.add(tag[2] as Role)
        }
      }
    }
    this.cache.set(key, { at: now, roles })
    return roles
  }
}

const books = new Map<string, RoleBook>()

/** One book per set of anchors and isolate, shared by HTTP requests and the hub. */
export function roleBookFor(anchors: readonly string[]): RoleBook {
  const key = anchors.join(',')
  let book = books.get(key)
  if (!book) books.set(key, (book = new RoleBook(anchors)))
  return book
}
