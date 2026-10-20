import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NOSTR_KIND, SECONDS_PER_DAY, isCityId } from '@smartcity/schemas'
import { build, type DailySnapshot } from './daily.js'
import { fetchDeletions, wsUrl } from './relays.js'
import {
  exists,
  paths,
  readPublished,
  write,
  type Files,
  type SnapshotDeps,
  type SnapshotOptions,
} from './snapshot.js'

/**
 * SNAP-9: with the default maximum age of relays (30 days, RELAY-5) a day stops getting addenda 30 days after it
 * ends, so a month is consolidated once its last day is that old.
 */
export const MAX_AGE_SECONDS = 30 * SECONDS_PER_DAY

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/

export interface MonthlyOptions extends Omit<SnapshotOptions, 'day' | 'relays'> {
  /** UTC month `YYYY-MM`. */
  month: string
  /** Relays asked for the deletions they know (SNAP-3); none to apply only those already archived. */
  relays: string[]
}

export interface MonthlyResult {
  snapshot: DailySnapshot
  files: Files
  /** Files of the month it joined, the dailies and their addenda. */
  joined: number
  /** Relays that could not be read, with the reason. */
  failed: { relay: string; reason: string }[]
}

/** UTC month `YYYY-MM` as the half-open range `[from, to)` in seconds; null if it is not a month. */
export function utcMonthRange(month: string): { from: number; to: number } | null {
  const m = MONTH.exec(month)
  if (!m) return null
  const year = Number(m[1])
  const index = Number(m[2]) - 1
  return { from: Date.UTC(year, index, 1) / 1000, to: Date.UTC(year, index + 1, 1) / 1000 }
}

/** Paths of the consolidated file of a month and of its `snapshot` event: `sc_<city>_<YYYY-MM>` (SNAP-4). */
export function monthlyPaths(out: string, city: string, month: string): Files {
  const base = join(out, `sc_${city}_${month}`)
  return { archive: `${base}.ndjson.gz`, torrent: `${base}.ndjson.gz.torrent`, event: `${base}.snapshot.json` }
}

/** The `relays` of a published `snapshot` event, so the consolidated file lists where its events came from. */
async function relaysOf(event: string): Promise<string[]> {
  const content = JSON.parse((JSON.parse(await readFile(event, 'utf8')) as { content: string }).content) as {
    relays?: unknown
  }
  return Array.isArray(content.relays) ? content.relays.filter((r): r is string => typeof r === 'string') : []
}

/**
 * `archiver monthly --city <c> --month <YYYY-MM> --out <dir>` (SNAP-4): joins the daily files and addenda of a
 * month already in `--out` into one file and one torrent, with its `snapshot` event (`["t", "monthly"]`, `from` the
 * start of the month and `to` the start of the next) carrying `cid`, `magnet` and `urls`, like the dailies.
 *
 * - Refuses a month whose last day can still get addenda (SNAP-9) and a month with a day lacking its daily file.
 * - Checks each file against the `x` of its event and each event's `id` and `sig` again (SNAP-6).
 * - Leaves out what a kind 5 of its author deletes, from the month's files or from `relays`, if given (SNAP-3).
 * - Never overwrites a file (SNAP-2): the consolidated month is written once.
 */
export async function runMonthly(options: MonthlyOptions, deps: SnapshotDeps): Promise<MonthlyResult> {
  if (!isCityId(options.city)) throw new Error(`--city must be a city id: ${options.city}`)
  const range = utcMonthRange(options.month)
  if (!range) throw new Error(`--month must be a UTC month YYYY-MM: ${options.month}`)
  if (deps.now < range.to + MAX_AGE_SECONDS) {
    throw new Error(`${options.month} can still get addenda: its last day is not 30 days old yet (SNAP-9)`)
  }
  const files = monthlyPaths(options.out, options.city, options.month)
  for (const path of [files.archive, files.event]) {
    if (await exists(path)) throw new Error(`${path} already exists: published files are not rewritten (SNAP-2)`)
  }

  const events: unknown[] = []
  const deletions: unknown[] = []
  const relays = new Set<string>()
  const missing: string[] = []
  let joined = 0
  for (let from = range.from; from < range.to; from += SECONDS_PER_DAY) {
    const day = new Date(from * 1000).toISOString().slice(0, 10)
    if (!(await exists(paths(options.out, options.city, day, 0).archive))) {
      missing.push(day)
      continue
    }
    for (let n = 0; ; n++) {
      const published = paths(options.out, options.city, day, n)
      if (n > 0 && !(await exists(published.archive))) break
      for (const event of await readPublished(published)) {
        events.push(event)
        // Deletions already archived keep applying even if no relay serves them any more (SNAP-3).
        if (event.kind === NOSTR_KIND.DELETION) deletions.push(event)
      }
      for (const relay of await relaysOf(published.event)) relays.add(relay)
      joined++
    }
  }
  if (missing.length > 0) {
    throw new Error(`no daily file in ${options.out} for ${missing.join(', ')}: run archiver snapshot first (SNAP-4)`)
  }

  const failed: MonthlyResult['failed'] = []
  if (options.relays.length > 0) {
    const results = await Promise.allSettled(
      options.relays.map((relay) => fetchDeletions(deps.fetch, relay, range.from, deps.log)),
    )
    results.forEach((result, i) => {
      const relay = options.relays[i]!
      if (result.status === 'fulfilled') {
        deletions.push(...result.value)
        relays.add(wsUrl(relay))
        deps.log(`${relay}: ${result.value.length} deletions`)
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
        failed.push({ relay, reason })
        deps.log(`${relay}: skipped (${reason})`)
      }
    })
    if (failed.length === options.relays.length) throw new Error('no relay could be read')
  }

  const name = `sc_${options.city}_${options.month}.ndjson.gz`
  const input = { city: options.city, events, deletions, relays: [...relays].sort(), now: deps.now }
  const snapshot = build(input, range, 'monthly', name, new Set())
  for (const { id, reason } of snapshot.discarded) deps.log(`discarded ${id}: ${reason}`)
  deps.log(`${options.month}: joined ${joined} files`)
  await write(files, snapshot, options, deps.log)
  return { snapshot, files, joined, failed }
}
