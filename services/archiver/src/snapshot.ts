import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { KIND, NOSTR_KIND, isCityId, utcDayRange, validateContent } from '@smartcity/schemas'
import { GRACE_SECONDS, buildAddendum, buildDaily, type DailySnapshot } from './daily.js'
import { fetchDay, fetchDeletions, wsUrl, type Fetch } from './relays.js'
import { createTorrent, seedUrl } from './torrent.js'

export interface SnapshotOptions {
  city: string
  day: string
  relays: string[]
  /** Directory where the files are written. */
  out: string
  /**
   * DIST-3: base URLs where the files will be published over HTTP (GitHub Releases, R2, a mirror). Each file's URL
   * goes into the torrent as a web seed and into the event's `urls`.
   */
  webSeeds?: string[]
  /** Trackers of the torrent; `DEFAULT_TRACKERS` when absent, none with an empty list (DHT and web seeds only). */
  trackers?: string[]
}

export interface SnapshotDeps {
  fetch: Fetch
  /** Seconds. */
  now: number
  log: (line: string) => void
}

export interface SnapshotResult {
  snapshot: DailySnapshot
  /** Paths of the `.ndjson.gz`, its `.torrent` and the unsigned `snapshot` event. */
  files: Files
  /** Relays that could not be read, with the reason. */
  failed: { relay: string; reason: string }[]
}

export interface AddendumResult extends Omit<SnapshotResult, 'files'> {
  /** Null when the relays had nothing the published files lack: no addendum is written. */
  files: Files | null
}

export interface Files {
  archive: string
  torrent: string
  event: string
}

/** Paths of a day's file and of its `snapshot` event: the daily with `n` 0, addendum `n` otherwise (SNAP-2). */
function paths(out: string, city: string, day: string, n: number): Files {
  const base = join(out, n === 0 ? `sc_${city}_${day}` : `sc_${city}_${day}_a${n}`)
  return { archive: `${base}.ndjson.gz`, torrent: `${base}.ndjson.gz.torrent`, event: `${base}.snapshot.json` }
}

function checkOptions(options: SnapshotOptions, now: number): { from: number; to: number } {
  if (!isCityId(options.city)) throw new Error(`--city must be a city id: ${options.city}`)
  const range = utcDayRange(options.day)
  if (!range) throw new Error(`--day must be a UTC date YYYY-MM-DD: ${options.day}`)
  if (options.relays.length === 0) throw new Error('at least one --relay is needed (SNAP-5)')
  // Checked again by buildDaily; here it saves asking the relays for a day that cannot be archived yet.
  if (now < range.to + GRACE_SECONDS) throw new Error(`${options.day} is still in the 48 h grace period (SNAP-1)`)
  return range
}

/**
 * Reads the day and the known deletions of every relay at the same time (SNAP-5, SNAP-3). One that fails is
 * reported and skipped, since none is mandatory; with none readable it throws.
 */
async function readRelays(options: SnapshotOptions, since: number, deps: SnapshotDeps) {
  const results = await Promise.allSettled(
    options.relays.map(async (relay) => {
      const [day, known] = await Promise.all([
        fetchDay(deps.fetch, relay, options.city, options.day),
        fetchDeletions(deps.fetch, relay, since, deps.log),
      ])
      deps.log(`${relay}: ${day.length} events, ${known.length} deletions`)
      return { day, known }
    }),
  )
  const events: unknown[] = []
  const deletions: unknown[] = []
  const read: string[] = []
  const failed: SnapshotResult['failed'] = []
  results.forEach((result, i) => {
    const relay = options.relays[i]!
    if (result.status === 'fulfilled') {
      events.push(...result.value.day)
      deletions.push(...result.value.known)
      read.push(wsUrl(relay))
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      failed.push({ relay, reason })
      deps.log(`${relay}: skipped (${reason})`)
    }
  })
  if (read.length === 0) throw new Error('no relay could be read')
  return { events, deletions, read, failed }
}

/**
 * DIST-1 to DIST-3: the torrent of the file, with its web seeds, and the `magnet` and `urls` of the event. They go
 * into the content before signing, so the signed event already says where to download the file.
 */
function distribute(snapshot: DailySnapshot, options: SnapshotOptions) {
  const urls = (options.webSeeds ?? []).map((base) => seedUrl(base, snapshot.name))
  const torrent = createTorrent(snapshot.gzip, { name: snapshot.name, trackers: options.trackers, webSeeds: urls })
  const content = { ...snapshot.content, magnet: torrent.magnet, ...(urls.length > 0 ? { urls } : {}) }
  const valid = validateContent(KIND.SNAPSHOT, content)
  if (!valid.ok) throw new Error(`snapshot content does not validate: ${valid.errors.join('; ')}`)
  snapshot.content = content
  snapshot.template = { ...snapshot.template, content: JSON.stringify(content) }
  return torrent
}

async function write(files: Files, snapshot: DailySnapshot, options: SnapshotOptions, log: (line: string) => void) {
  const torrent = distribute(snapshot, options)
  await mkdir(options.out, { recursive: true })
  await writeFile(files.archive, snapshot.gzip, { flag: 'wx' })
  await writeFile(files.torrent, torrent.bytes, { flag: 'wx' })
  await writeFile(files.event, JSON.stringify(snapshot.template, null, 2) + '\n', { flag: 'wx' })
  log(`${files.torrent}: btih ${torrent.infoHash}`)
  log(
    `${snapshot.name}: ${snapshot.content.count} events, ${snapshot.deleted} deleted, ` +
      `${snapshot.discarded.length} discarded, x=${snapshot.content.x}`,
  )
}

/**
 * `archiver snapshot --city <c> --day <YYYY-MM-DD> --relay <url>…` (docs/spec/06): joins the day of every relay
 * (SNAP-5), applies the deletions they know (SNAP-3) and writes the daily file and the `snapshot` event to sign.
 * Relays are read at the same time; one that fails is reported and skipped, since none is mandatory; with none
 * readable nothing is written. Files already there are never overwritten (SNAP-2): late events go to an addendum.
 */
export async function runSnapshot(options: SnapshotOptions, deps: SnapshotDeps): Promise<SnapshotResult> {
  const range = checkOptions(options, deps.now)
  const files = paths(options.out, options.city, options.day, 0)
  // Checked before asking the relays; the writes use `wx` as well, in case another run gets there first.
  for (const path of [files.archive, files.event]) {
    if (await exists(path)) throw new Error(`${path} already exists: published files are not rewritten (SNAP-2)`)
  }

  const { events, deletions, read, failed } = await readRelays(options, range.from, deps)
  const snapshot = buildDaily({ city: options.city, day: options.day, events, deletions, relays: read, now: deps.now })
  for (const { id, reason } of snapshot.discarded) deps.log(`discarded ${id}: ${reason}`)
  await write(files, snapshot, options, deps.log)
  return { snapshot, files, failed }
}

/**
 * `archiver addendum --city <c> --day <YYYY-MM-DD> --relay <url>…` (SNAP-2): for a day whose daily file is already
 * in `--out`, reads the relays again and writes `sc_<city>_<day>_a<N>.ndjson.gz` and its `snapshot` event with the
 * valid events that neither the daily nor the earlier addenda have. Published files are checked against their
 * `x` and never rewritten. With nothing new, nothing is written.
 */
export async function runAddendum(options: SnapshotOptions, deps: SnapshotDeps): Promise<AddendumResult> {
  const range = checkOptions(options, deps.now)
  if (!(await exists(paths(options.out, options.city, options.day, 0).archive))) {
    throw new Error(`no daily file of ${options.day} in ${options.out}: run archiver snapshot first (SNAP-2)`)
  }
  const archived = new Set<string>()
  // Deletions already archived keep applying even if the relay that knew them is no longer read (SNAP-3).
  const archivedDeletions: unknown[] = []
  let n = 0
  for (;;) {
    const files = paths(options.out, options.city, options.day, n)
    if (n > 0 && !(await exists(files.archive))) break
    for (const event of await readPublished(files)) {
      archived.add(event.id)
      if (event.kind === NOSTR_KIND.DELETION) archivedDeletions.push(event)
    }
    n++
  }
  const files = paths(options.out, options.city, options.day, n)
  if (await exists(files.event)) throw new Error(`${files.event} already exists: published files are not rewritten (SNAP-2)`)

  const { events, deletions, read, failed } = await readRelays(options, range.from, deps)
  const snapshot = buildAddendum({
    city: options.city,
    day: options.day,
    events,
    deletions: [...archivedDeletions, ...deletions],
    relays: read,
    now: deps.now,
    archived,
    n,
  })
  for (const { id, reason } of snapshot.discarded) deps.log(`discarded ${id}: ${reason}`)
  if (snapshot.content.count === 0) {
    deps.log(`${options.day}: nothing new since the published files (${snapshot.archived} already archived)`)
    return { snapshot, files: null, failed }
  }
  await write(files, snapshot, options, deps.log)
  return { snapshot, files, failed }
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

/**
 * Lines of a published file, after checking it against the `x` and `file.x` of its `snapshot` event (SNAP-6):
 * an addendum built on a damaged file would repeat or miss events, so a mismatch stops the run.
 */
async function readPublished(files: { archive: string; event: string }): Promise<{ id: string; kind: number }[]> {
  const gzip = await readFile(files.archive)
  let expected: { x?: unknown; file?: { x?: unknown } }
  try {
    const event = JSON.parse(await readFile(files.event, 'utf8')) as { content: string }
    expected = JSON.parse(event.content) as typeof expected
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${files.event}: cannot read the snapshot event (${reason})`, { cause: error })
  }
  const ndjson = gunzipSync(gzip).toString('utf8')
  if (sha256(gzip) !== expected.file?.x || sha256(ndjson) !== expected.x) {
    throw new Error(`${files.archive} does not match the x of ${files.event}`)
  }
  return ndjson
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { id: string; kind: number })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
