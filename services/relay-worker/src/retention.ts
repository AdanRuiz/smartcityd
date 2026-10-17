import { KIND, NOSTR_KIND, SECONDS_PER_DAY, tagValues } from '@smartcity/schemas'
import type { Config } from './config.js'
import type { NostrEvent } from './event.js'
import type { RoleBook } from './roles.js'
import type { Store } from './store.js'

/** Never purged by age (docs/spec/07, "Retención"): deletions, OpenTimestamps proofs and snapshots. */
export const KEEP_KINDS: readonly number[] = [NOSTR_KIND.DELETION, NOSTR_KIND.OPENTIMESTAMPS, KIND.SNAPSHOT]

// Bounds per run, so one cron invocation stays inside the free plan's subrequest and CPU limits.
// What is left over is purged by the next runs.
export const MAX_DAYS_PER_RUN = 20
export const MAX_PROBES_PER_RUN = 40

// Snapshots that cover a day of events; `attachments` covers blobs, not events (SNAP-13).
const COVERING = new Set(['daily', 'monthly'])
const ADDENDUM = 'addendum'

interface SnapshotFile {
  pubkey: string
  type: string
  from: number
  to: number
  count: number
  name: string
  size: number
  urls: string[]
}

export interface RetentionDeps {
  store: Store
  config: Config
  roles: RoleBook
  /** HEAD requests to snapshot URLs; `fetch` in the Worker. */
  fetch: (url: string, init: { method: 'HEAD' }) => Promise<Response>
  now: number
}

export interface RetentionReport {
  expiredRows: number
  purgedDays: { city: string; day: number }[]
  /** Days old enough to purge that RELAY-4 kept, with the reason. */
  keptDays: { city: string; day: number; reason: string }[]
  purgedRows: number
  /** Why purging by age did not run at all, when it did not. */
  ageSkipped?: string
}

export const NO_ANCHORS = 'no TRUST_ANCHORS: purging by age is disabled (RELAY-4, ADR-20)'

/** Parses a stored snapshot event; null if it does not describe an events file. */
function snapshotFile(event: NostrEvent): SnapshotFile | null {
  let content: unknown
  try {
    content = JSON.parse(event.content)
  } catch {
    return null
  }
  const c = content as Partial<{ from: number; to: number; count: number; file: { name: string; size: number } }> & {
    urls?: unknown
    magnet?: unknown
  }
  const type = tagValues(event.tags, 't')[0] ?? ''
  if (typeof c.from !== 'number' || typeof c.to !== 'number' || typeof c.count !== 'number') return null
  if (typeof c.file?.name !== 'string' || typeof c.file.size !== 'number') return null
  const urls = Array.isArray(c.urls) ? c.urls.filter((u): u is string => typeof u === 'string') : []
  if (typeof c.magnet === 'string') urls.push(...webSeeds(c.magnet, c.file.name))
  return {
    pubkey: event.pubkey,
    type,
    from: c.from,
    to: c.to,
    count: c.count,
    name: c.file.name,
    size: c.file.size,
    urls: [...new Set(urls)].filter((u) => /^https?:\/\//.test(u)),
  }
}

/** `ws=` web seeds of a magnet (DIST-3). A seed ending in `/` is a directory: the file name goes after it (BEP 19). */
export function webSeeds(magnet: string, fileName: string): string[] {
  if (!magnet.startsWith('magnet:?')) return []
  return new URLSearchParams(magnet.slice('magnet:?'.length))
    .getAll('ws')
    .map((seed) => (seed.endsWith('/') ? seed + encodeURIComponent(fileName) : seed))
}

/**
 * Daily retention task (docs/spec/07, "Retención"): deletes expired events and, for regular events older than
 * `RETENTION_DAYS`, purges a day only when it is archived (RELAY-4):
 *
 * 1. a `daily` or `monthly` snapshot of the city covers it, signed by a key with role `archiver` from
 *    `TRUST_ANCHORS`;
 * 2. its file is obtainable: a HEAD to one of its `urls` or web seeds answers with `Content-Length` equal to
 *    `file.size`;
 * 3. its `count`, plus those of the obtainable addenda of the same archiver and range, is at least the number of
 *    events the relay holds in that range.
 *
 * Deletions, OpenTimestamps proofs, snapshots and addressable events are never purged. `RETENTION_DAYS=0`
 * disables purging by age, and so does an empty `TRUST_ANCHORS` (ADR-20): without anchors anyone could sign a
 * snapshot that covers a day and have its real events deleted.
 */
export async function runRetention(deps: RetentionDeps): Promise<RetentionReport> {
  const { store, config, now } = deps
  const report: RetentionReport = { expiredRows: 0, purgedDays: [], keptDays: [], purgedRows: 0 }
  report.expiredRows = await store.deleteExpired(now)
  if (config.retentionDays === 0) return report
  if (config.trustAnchors.length === 0) {
    report.ageSkipped = NO_ANCHORS
    return report
  }

  const cutoff = now - config.retentionDays * SECONDS_PER_DAY
  // Whole days only: the day must end before the cutoff.
  const days = await store.purgeableDays(cutoff - SECONDS_PER_DAY + 1, KEEP_KINDS, MAX_DAYS_PER_RUN)
  const probes = new Prober(deps.fetch)
  for (const { city, day } of days) {
    const range = { from: day, to: day + SECONDS_PER_DAY }
    const reason = await archived(city, range, deps, probes)
    if (reason !== null) {
      report.keptDays.push({ city, day, reason })
      continue
    }
    report.purgedRows += await store.deleteRegularRange(city, range, KEEP_KINDS)
    report.purgedDays.push({ city, day })
  }
  return report
}

/** null when the day is archived (RELAY-4); otherwise why not. */
async function archived(
  city: string,
  day: { from: number; to: number },
  deps: RetentionDeps,
  probes: Prober,
): Promise<string | null> {
  const { store, roles, now } = deps
  // Snapshots are published after the day they cover (SNAP-1).
  const events = await store.query({ kinds: [KIND.SNAPSHOT], since: day.from, tags: { c: [city] } }, now)
  const files: SnapshotFile[] = []
  for (const event of events) {
    const file = snapshotFile(event)
    if (!file) continue
    if (!(await roles.rolesOf(file.pubkey, city, store, now)).has('archiver')) continue
    files.push(file)
  }
  const covering = files.filter((f) => COVERING.has(f.type) && f.from <= day.from && f.to >= day.to)
  if (covering.length === 0) return 'no snapshot from an archiver covers the day'

  let reason = 'no snapshot file is obtainable'
  for (const snapshot of covering) {
    if (!(await probes.obtainable(snapshot))) continue
    let count = snapshot.count
    for (const addendum of files) {
      if (addendum.type !== ADDENDUM || addendum.pubkey !== snapshot.pubkey) continue
      if (addendum.from !== snapshot.from || addendum.to !== snapshot.to) continue
      if (await probes.obtainable(addendum)) count += addendum.count
    }
    const stored = await store.countRange(city, { from: snapshot.from, to: snapshot.to })
    if (count >= stored) return null
    reason = `snapshot count ${count} is below the ${stored} events stored`
  }
  return reason
}

/** HEAD probes, each URL at most once per run and at most MAX_PROBES_PER_RUN in total. */
class Prober {
  private readonly seen = new Map<string, boolean>()

  constructor(private readonly fetch: RetentionDeps['fetch']) {}

  async obtainable(file: SnapshotFile): Promise<boolean> {
    for (const url of file.urls) if (await this.matches(url, file.size)) return true
    return false
  }

  private async matches(url: string, size: number): Promise<boolean> {
    const key = `${size} ${url}`
    const known = this.seen.get(key)
    if (known !== undefined) return known
    if (this.seen.size >= MAX_PROBES_PER_RUN) return false
    let ok: boolean
    try {
      const response = await this.fetch(url, { method: 'HEAD' })
      ok = response.ok && Number(response.headers.get('Content-Length')) === size
    } catch {
      ok = false
    }
    this.seen.set(key, ok)
    return ok
  }
}
