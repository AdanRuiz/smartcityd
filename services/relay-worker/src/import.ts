import { KIND, tagValues } from '@smartcity/schemas'
import { verifyEvent } from 'nostr-tools/pure'
import { acceptEvent, type AcceptDeps } from './accept.js'
import type { NostrEvent } from './event.js'
import { RateLimiter } from './ratelimit.js'

export type ImportDeps = Omit<AcceptDeps, 'limiter' | 'origin'>

export interface ImportReport {
  /** New events, replacements included, in file order. */
  stored: NostrEvent[]
  /** Already stored, or beaten by a stored version (DATA-3). */
  duplicates: number
  /** Ephemeral events, which are not archived and are not stored. */
  skipped: number
  /** Lines discarded, with the reason (SNAP-6): they do not invalidate the rest. */
  invalid: { line: number; id: string; reason: string }[]
}

const encoder = new TextEncoder()

async function sha256(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Checks a downloaded snapshot file against its `snapshot` event (docs/spec/06, SNAP-6): the event's signature,
 * the size and sha256 of the file as downloaded (`file.size`, `file.x`) and the canonical hash `x` of the
 * uncompressed NDJSON. `file` is the downloaded bytes and `ndjson` their uncompressed text (the same when the
 * file is not compressed). Returns null when everything matches, otherwise the reason.
 */
export async function checkSnapshotFile(file: Uint8Array, ndjson: string, snapshot: NostrEvent): Promise<string | null> {
  if (snapshot.kind !== KIND.SNAPSHOT) return `event ${snapshot.id} is not a snapshot`
  if (!verifyEvent(snapshot)) return `snapshot ${snapshot.id} does not verify`
  let content: { x?: unknown; file?: { x?: unknown; size?: unknown } }
  try {
    content = JSON.parse(snapshot.content) as typeof content
  } catch {
    return `snapshot ${snapshot.id} has no JSON content`
  }
  if (typeof content.file?.size === 'number' && content.file.size !== file.length) {
    return `file size ${file.length} does not match file.size ${content.file.size}`
  }
  if (typeof content.file?.x === 'string' && content.file.x !== (await sha256(file))) {
    return 'sha256 of the file does not match file.x'
  }
  const x = await sha256(encoder.encode(ndjson))
  if (content.x !== x || !tagValues(snapshot.tags, 'x').includes(x)) {
    return 'sha256 of the uncompressed NDJSON does not match x'
  }
  return null
}

/**
 * Imports the events of a snapshot file (docs/spec/06 NDJSON, one event per line) into the relay. Each line goes
 * through the acceptance of docs/spec/07 except the age and rate limits, which are for clients (RELAY-5): id,
 * signature, schema, proof of work and operator policy still apply. An invalid line is discarded and reported,
 * and the rest is imported (SNAP-6).
 */
export async function importNdjson(ndjson: string, deps: ImportDeps): Promise<ImportReport> {
  const report: ImportReport = { stored: [], duplicates: 0, skipped: 0, invalid: [] }
  const accept = { ...deps, limiter: new RateLimiter(), origin: 'snapshot' as const }
  const lines = ndjson.split('\n')
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      report.invalid.push({ line: index + 1, id: '', reason: 'invalid: line is not JSON' })
      continue
    }
    const result = await acceptEvent(raw, 'snapshot', accept)
    if (!result.ok) report.invalid.push({ line: index + 1, id: result.id, reason: result.message })
    else if (result.status === 'stored' || result.status === 'replaced') report.stored.push(result.event)
    else if (result.status === 'ephemeral') report.skipped++
    else report.duplicates++
  }
  return report
}
