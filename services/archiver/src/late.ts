import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isCityId, utcDayRange } from '@smartcity/schemas'
import { buildAddendum, type DailySnapshot } from './daily.js'
import { RECEIVED_START, fetchDeletions, fetchReceived, wsUrl } from './relays.js'
import { exists, paths, publishedDay, write, type Files, type SnapshotDeps, type SnapshotOptions } from './snapshot.js'

export type LateOptions = Omit<SnapshotOptions, 'day'>

export interface LateResult {
  /** Addenda written, one per published day that got events its files lack (SNAP-2). */
  addenda: { day: string; snapshot: DailySnapshot; files: Files }[]
  /** Relays that could not be read, with the reason: their cursor stays where it was. */
  failed: { relay: string; reason: string }[]
  /** Cursor of each relay after the run, keyed by its `wss://` URL, as saved in the cursor file. */
  cursors: Record<string, string>
}

interface Read {
  relay: string
  events: unknown[]
  cursor: string
}

/** File in `--out` where the archiver keeps the `received_after` cursor of each relay of a city (SNAP-8). */
export function cursorPath(out: string, city: string): string {
  return join(out, `sc_${city}.cursors.json`)
}

async function readCursors(path: string): Promise<Record<string, string>> {
  if (!(await exists(path))) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error(`${path} is not JSON`)
  }
  const valid =
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.values(parsed).every((v) => typeof v === 'string')
  if (!valid) throw new Error(`${path} must map each relay to its cursor`)
  return parsed as Record<string, string>
}

/** UTC day `YYYY-MM-DD` of a relay line, or null without a usable `created_at`; `buildAddendum` checks the rest. */
function dayOf(value: unknown): string | null {
  const createdAt = (value as { created_at?: unknown } | null)?.created_at
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) return null
  return new Date(createdAt * 1000).toISOString().slice(0, 10)
}

/**
 * `archiver late --city <c> --relay <url>…` (SNAP-8): asks each relay only for what it received since the cursor
 * saved for it last time (`GET /v1/export?received_after=`), so days already archived are not read again. Events
 * of a day whose daily file is in `--out` go to a new addendum of that day (SNAP-2), with the same checks and
 * deletions as `archiver addendum` (SNAP-3, SNAP-5); events of other days are left for `archiver snapshot`, which
 * reads the whole day. Cursors are saved only after the addenda are written, so an interrupted run asks again
 * from the same place and the published files keep it from repeating events. A relay that fails, or lacks the
 * route, is reported and its cursor stays; with none readable nothing is written.
 */
export async function runLate(options: LateOptions, deps: SnapshotDeps): Promise<LateResult> {
  if (!isCityId(options.city)) throw new Error(`--city must be a city id: ${options.city}`)
  if (options.relays.length === 0) throw new Error('at least one --relay is needed (SNAP-5)')
  const cursorFile = cursorPath(options.out, options.city)
  const saved = await readCursors(cursorFile)

  const failed: LateResult['failed'] = []
  const fail = (relay: string, error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    failed.push({ relay, reason })
    deps.log(`${relay}: skipped (${reason})`)
  }
  const received = await Promise.allSettled(
    options.relays.map((relay) => fetchReceived(deps.fetch, relay, options.city, saved[wsUrl(relay)] ?? RECEIVED_START)),
  )
  let read: Read[] = []
  received.forEach((result, i) => {
    const relay = options.relays[i]!
    if (result.status === 'rejected') return fail(relay, result.reason)
    deps.log(`${relay}: ${result.value.events.length} events received since the last run`)
    read.push({ relay, ...result.value })
  })
  if (read.length === 0) throw new Error('no relay could be read')

  // Only days with a published daily get an addendum; the others are read whole by `archiver snapshot`.
  const published = new Map<string, boolean>()
  const isPublished = async (day: string) => {
    if (!published.has(day)) published.set(day, await exists(paths(options.out, options.city, day, 0).archive))
    return published.get(day)!
  }
  for (const { events } of read) {
    for (const event of events) {
      const day = dayOf(event)
      if (day !== null) await isPublished(day)
    }
  }
  const days = [...published].filter(([, yes]) => yes).map(([day]) => day).sort()
  const unpublished = [...published].filter(([, yes]) => !yes).map(([day]) => day).sort()
  if (unpublished.length > 0) {
    deps.log(`days without a daily file in ${options.out}, left for archiver snapshot: ${unpublished.join(', ')}`)
  }

  const deletions: unknown[] = []
  if (days.length > 0) {
    // Deletions need not carry `c`, so they do not come in the city's export: they are asked as `addendum` does,
    // from the start of the oldest day with late events (SNAP-3). A relay whose deletions cannot be read does not
    // contribute this run: its cursor stays, so its events come again next time.
    const since = utcDayRange(days[0]!)!.from
    const known = await Promise.allSettled(read.map(({ relay }) => fetchDeletions(deps.fetch, relay, since, deps.log)))
    read = read.filter((_, i) => {
      const result = known[i]!
      if (result.status === 'rejected') return (fail(read[i]!.relay, result.reason), false)
      deletions.push(...result.value)
      return true
    })
    if (read.length === 0) throw new Error('no relay could be read')
  }

  const relays = read.map(({ relay }) => wsUrl(relay))
  const addenda: LateResult['addenda'] = []
  for (const day of days) {
    const events = read.flatMap((r) => r.events.filter((event) => dayOf(event) === day))
    if (events.length === 0) continue
    const { archived, archivedDeletions, n, files } = await publishedDay(options.out, options.city, day)
    const snapshot = buildAddendum({
      city: options.city,
      day,
      events,
      deletions: [...archivedDeletions, ...deletions],
      relays,
      now: deps.now,
      archived,
      n,
    })
    for (const { id, reason } of snapshot.discarded) deps.log(`discarded ${id}: ${reason}`)
    if (snapshot.content.count === 0) {
      deps.log(`${day}: nothing new since the published files (${snapshot.archived} already archived)`)
      continue
    }
    await write(files, snapshot, { ...options, day }, deps.log)
    addenda.push({ day, snapshot, files })
  }

  const cursors = { ...saved }
  for (const { relay, cursor } of read) cursors[wsUrl(relay)] = cursor
  // Through a temporary file, so an interrupted write never leaves a broken cursor file behind.
  await mkdir(options.out, { recursive: true })
  await writeFile(`${cursorFile}.tmp`, JSON.stringify(cursors, null, 2) + '\n')
  await rename(`${cursorFile}.tmp`, cursorFile)
  return { addenda, failed, cursors }
}
