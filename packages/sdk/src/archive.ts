// History from the daily snapshots (docs/spec/06, "Consulta de historial en la app"; docs/desarrolladores/historial.md).
import {
  KIND,
  NOSTR_KIND,
  SECONDS_PER_DAY,
  compareCanonical,
  deletionTargets,
  kindClass,
  tagValues,
  utcDayRange,
  type SnapshotContent,
} from '@smartcity/schemas'
import type { NostrEvent } from './event.js'
import { decodeUtf8, gunzip, sha256Hex, type Fetch } from './runtime.js'

/** Public IPFS gateways tried for the `cid` of a snapshot after its `urls`. A convenience, not a dependency. */
export const IPFS_GATEWAYS = ['https://ipfs.io', 'https://dweb.link']

export interface ArchiveQuery {
  /** First UTC day, `YYYY-MM-DD`. */
  from: string
  /** Last UTC day, included. Default: `from`. */
  to?: string
  /** Only events of these kinds. Default: all. */
  kinds?: number[]
  /** Only `snapshot` events signed by these keys, e.g. those with role `archiver`. Default: anyone's. */
  archivers?: string[]
  /** Each file no source delivered intact and each line discarded (SNAP-6). They do not stop the read. */
  onDiscard?: (discard: ArchiveDiscard) => void
}

export interface ArchiveDiscard {
  /** Id of the `snapshot` event of the file. */
  snapshot: string
  /** `file.name` of the snapshot. */
  name: string
  /** 1-based line of the NDJSON; absent when the whole file is discarded. */
  line?: number
  reason: string
}

export interface ArchiveDeps {
  fetch: Fetch
  gateways: string[]
  /** `id`, `sig` and, for system kinds, schema of an archived event (SDK-5); null if valid, otherwise the reason. */
  check(raw: unknown): Promise<string | null>
  onDiscard(discard: ArchiveDiscard): void
}

type SnapshotType = 'daily' | 'addendum' | 'monthly'

export interface ArchiveFile {
  event: NostrEvent
  type: SnapshotType
  content: SnapshotContent
}

const VERIFY_BATCH = 500

/**
 * The files the `snapshot` events announce, one per canonical hash `x`: several archivers that saw the same
 * events publish the same `x`, and one download serves them all. Only NDJSON files whose `x` tag matches the content.
 */
export function announcedFiles(events: readonly NostrEvent[]): ArchiveFile[] {
  const byX = new Map<string, ArchiveFile>()
  for (const event of events) {
    if (event.kind !== KIND.SNAPSHOT) continue
    const type = tagValues(event.tags, 't')[0]
    if (type !== 'daily' && type !== 'addendum' && type !== 'monthly') continue
    let content: SnapshotContent
    try {
      content = JSON.parse(event.content) as SnapshotContent
    } catch {
      continue
    }
    if (content.format !== 'ndjson+gzip' || !tagValues(event.tags, 'x').includes(content.x)) continue
    if (!byX.has(content.x)) byX.set(content.x, { event, type, content })
  }
  return [...byX.values()]
}

/**
 * SNAP-6: the NDJSON of a file from the first source that delivers it intact: size and sha256 of the `.gz` as
 * downloaded (`file.size`, `file.x`), then sha256 of the uncompressed text (`x`). Its `urls` first, then its `cid`
 * on each gateway. Null, after reporting it, when none does.
 */
export async function download(file: ArchiveFile, deps: ArchiveDeps): Promise<string | null> {
  const { content } = file
  const sources = [...(content.urls ?? [])]
  if (content.cid) for (const gateway of deps.gateways) sources.push(`${gateway.replace(/\/+$/, '')}/ipfs/${content.cid}`)
  const reasons: string[] = []
  for (const url of sources) {
    try {
      const res = await deps.fetch(url)
      if (!res.ok) throw new Error('not found')
      const gzip = new Uint8Array(await res.arrayBuffer())
      if (gzip.length !== content.file.size) throw new Error(`size ${gzip.length}, file.size ${content.file.size}`)
      if ((await sha256Hex(gzip)) !== content.file.x) throw new Error('sha256 does not match file.x')
      const ndjson = await gunzip(gzip)
      if ((await sha256Hex(ndjson)) !== content.x) throw new Error('sha256 of the NDJSON does not match x')
      return decodeUtf8(ndjson)
    } catch (error) {
      reasons.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  deps.onDiscard({
    snapshot: file.event.id,
    name: content.file.name,
    reason: reasons.length > 0 ? `no source delivered it intact (${reasons.join('; ')})` : 'no urls or cid',
  })
  return null
}

/** SNAP-6: every line checked on its own; an invalid one is discarded and reported, and the rest still counts. */
export async function eventsOf(file: ArchiveFile, ndjson: string, deps: ArchiveDeps): Promise<NostrEvent[]> {
  const lines = ndjson.split('\n')
  const out: NostrEvent[] = []
  for (let start = 0; start < lines.length; start += VERIFY_BATCH) {
    const batch = lines.slice(start, start + VERIFY_BATCH)
    const checked = await Promise.all(
      batch.map(async (line, i) => {
        if (line.trim() === '') return null
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          return { line: start + i + 1, reason: 'line is not JSON' }
        }
        const reason = await deps.check(raw)
        return reason === null ? (raw as NostrEvent) : { line: start + i + 1, reason }
      }),
    )
    for (const result of checked) {
      if (result === null) continue
      if ('reason' in result) deps.onDiscard({ snapshot: file.event.id, name: file.content.file.name, ...result })
      else out.push(result)
    }
  }
  return out
}

/**
 * Deletions (kind 5) seen so far, with the targets the relay and the archiver use (`deletionTargets`, DATA-8):
 * `e` tags cover an event of the same author that is not a deletion; `a` tags, the versions of that address up to
 * the deletion's date.
 */
export class Deletions {
  private readonly ids = new Map<string, Set<string>>()
  private readonly addresses = new Map<string, number>()

  add(deletion: NostrEvent): void {
    if (deletion.kind !== NOSTR_KIND.DELETION) return
    const { ids, addresses } = deletionTargets(deletion)
    for (const id of ids) this.ids.set(id, (this.ids.get(id) ?? new Set<string>()).add(deletion.pubkey))
    for (const { kind, pubkey, d, until } of addresses) {
      const key = `${kind}:${pubkey}:${d}`
      this.addresses.set(key, Math.max(this.addresses.get(key) ?? -Infinity, until))
    }
  }

  covers(event: NostrEvent): boolean {
    if (event.kind === NOSTR_KIND.DELETION) return false
    if (this.ids.get(event.id)?.has(event.pubkey)) return true
    if (kindClass(event.kind) !== 'addressable') return false
    const until = this.addresses.get(`${event.kind}:${event.pubkey}:${tagValues(event.tags, 'd')[0] ?? ''}`)
    return until !== undefined && event.created_at <= until
  }
}

/** UTC days of a query as the starts of their ranges, in seconds. Throws on a bad day or an inverted range. */
export function daysOf(query: Pick<ArchiveQuery, 'from' | 'to'>): number[] {
  const first = utcDayRange(query.from)
  const last = utcDayRange(query.to ?? query.from)
  if (!first) throw new Error(`not a UTC day YYYY-MM-DD: ${query.from}`)
  if (!last) throw new Error(`not a UTC day YYYY-MM-DD: ${String(query.to)}`)
  if (last.from < first.from) throw new Error(`archive range ends before it starts: ${query.from} to ${String(query.to)}`)
  const days: number[] = []
  for (let day = first.from; day <= last.from; day += SECONDS_PER_DAY) days.push(day)
  return days
}

/**
 * The events of each day in the range, oldest first (`created_at`, then `id`, as in the NDJSON). For each day it
 * downloads and verifies its daily file and every addendum (SNAP-2), from every archiver (several `x` are joined by
 * `id`, docs/spec/06 "Varios archivistas"). A day whose files no source delivers is taken from the monthly file of
 * its month (SNAP-4), if there is one. Only events dated inside the day count, so none comes twice. Deletions of the days read so far apply to what follows, so a deletion in an
 * addendum removes the event of its daily file; one published on a later day than the range is not seen here.
 */
export async function* readArchive(
  files: readonly ArchiveFile[],
  query: ArchiveQuery,
  deps: ArchiveDeps,
): AsyncGenerator<NostrEvent, void, undefined> {
  const days = daysOf(query)
  const kinds = query.kinds ? new Set(query.kinds) : null
  const deletions = new Deletions()
  const months = new Map<string, Promise<NostrEvent[] | null>>()
  const fileEvents = async (file: ArchiveFile): Promise<NostrEvent[] | null> => {
    const ndjson = await download(file, deps)
    return ndjson === null ? null : eventsOf(file, ndjson, deps)
  }
  for (const day of days) {
    const end = day + SECONDS_PER_DAY
    const byId = new Map<string, NostrEvent>()
    let read = false
    for (const file of files) {
      if (file.type === 'monthly' || file.content.from !== day || file.content.to !== end) continue
      const events = await fileEvents(file)
      if (events === null) continue
      read = true
      for (const event of events) if (event.created_at >= day && event.created_at < end) byId.set(event.id, event)
    }
    if (!read) {
      for (const file of files) {
        if (file.type !== 'monthly' || file.content.from > day || file.content.to < end) continue
        if (!months.has(file.content.x)) months.set(file.content.x, fileEvents(file))
        const events = await months.get(file.content.x)!
        if (events === null) continue
        for (const event of events) if (event.created_at >= day && event.created_at < end) byId.set(event.id, event)
      }
    }
    const events = [...byId.values()].sort(compareCanonical)
    for (const event of events) deletions.add(event)
    for (const event of events) {
      if (!deletions.covers(event) && (!kinds || kinds.has(event.kind))) yield event
    }
  }
}
