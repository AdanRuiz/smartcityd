import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isCityId, utcDayRange, type SignedEvent } from '@smartcity/schemas'
import { GRACE_SECONDS, buildDaily, type DailySnapshot } from './daily.js'
import { fetchDay, fetchDeletions, wsUrl, type Fetch } from './relays.js'

export interface SnapshotOptions {
  city: string
  day: string
  relays: string[]
  /** Directory where the files are written. */
  out: string
}

export interface SnapshotDeps {
  fetch: Fetch
  /** Seconds. */
  now: number
  log: (line: string) => void
}

export interface SnapshotResult {
  snapshot: DailySnapshot
  /** Paths of the `.ndjson.gz` and of the unsigned `snapshot` event. */
  files: { archive: string; event: string }
  /** Relays that could not be read, with the reason. */
  failed: { relay: string; reason: string }[]
}

/**
 * `archiver snapshot --city <c> --day <YYYY-MM-DD> --relay <url>…` (docs/spec/06): joins the day of every relay
 * (SNAP-5), applies the deletions they know (SNAP-3) and writes the daily file and the `snapshot` event to sign.
 * A relay that fails is reported and skipped, since none is mandatory; with none readable nothing is written.
 */
export async function runSnapshot(options: SnapshotOptions, deps: SnapshotDeps): Promise<SnapshotResult> {
  if (!isCityId(options.city)) throw new Error(`--city must be a city id: ${options.city}`)
  const range = utcDayRange(options.day)
  if (!range) throw new Error(`--day must be a UTC date YYYY-MM-DD: ${options.day}`)
  if (options.relays.length === 0) throw new Error('at least one --relay is needed (SNAP-5)')
  // Checked again by buildDaily; here it saves asking the relays for a day that cannot be archived yet.
  if (deps.now < range.to + GRACE_SECONDS) throw new Error(`${options.day} is still in the 48 h grace period (SNAP-1)`)

  const events: SignedEvent[] = []
  const deletions: SignedEvent[] = []
  const read: string[] = []
  const failed: SnapshotResult['failed'] = []
  for (const relay of options.relays) {
    try {
      const day = await fetchDay(deps.fetch, relay, options.city, options.day)
      const known = await fetchDeletions(deps.fetch, relay, range.from)
      events.push(...day)
      deletions.push(...known)
      read.push(wsUrl(relay))
      deps.log(`${relay}: ${day.length} events, ${known.length} deletions`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failed.push({ relay, reason })
      deps.log(`${relay}: skipped (${reason})`)
    }
  }
  if (read.length === 0) throw new Error('no relay could be read')

  const snapshot = buildDaily({ city: options.city, day: options.day, events, deletions, relays: read, now: deps.now })
  for (const { id, reason } of snapshot.discarded) deps.log(`discarded ${id}: ${reason}`)

  await mkdir(options.out, { recursive: true })
  const archive = join(options.out, snapshot.name)
  const event = join(options.out, snapshot.name.replace(/\.ndjson\.gz$/, '.snapshot.json'))
  await writeFile(archive, snapshot.gzip)
  await writeFile(event, JSON.stringify(snapshot.template, null, 2) + '\n')
  deps.log(
    `${snapshot.name}: ${snapshot.content.count} events, ${snapshot.deleted} deleted, ` +
      `${snapshot.discarded.length} discarded, x=${snapshot.content.x}`,
  )
  return { snapshot, files: { archive, event }, failed }
}
