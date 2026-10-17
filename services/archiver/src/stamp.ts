import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { KIND, type SignedEvent } from '@smartcity/schemas'
import { verifyEvent } from 'nostr-tools/pure'
import { parseDetached, parseTimestamp, serializeDetached, type Timestamp } from './ots.js'
import { REQUEST_TIMEOUT_MS } from './relays.js'
import { exists } from './snapshot.js'

/**
 * Public calendars used when none is given: the same ones the reference client (`ots stamp`) uses, run by three
 * different operators. Each aggregates many digests into one Bitcoin transaction for free (docs/spec/06).
 */
export const DEFAULT_CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://ots.btc.catallaxy.com',
]

/** A calendar answer is a few hundred bytes; anything far larger is not a proof. */
const MAX_RESPONSE_BYTES = 10_000

export type PostDigest = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: Uint8Array; signal: AbortSignal },
) => Promise<Response>

export interface StampOptions {
  /** Path of `<base>.snapshot.signed.json`, written by `archiver publish`. */
  event: string
  calendars: string[]
}

export interface StampDeps {
  fetch: PostDigest
  /** Random bytes for the nonce that hides the `id` from the calendars. */
  random: (length: number) => Uint8Array
  log: (line: string) => void
}

export interface StampResult {
  /** Path of `<base>.snapshot.ots`. */
  ots: string
  id: string
  accepted: string[]
  rejected: { calendar: string; reason: string }[]
}

function otsPath(event: string): string {
  if (!event.endsWith('.snapshot.signed.json')) throw new Error(`${event}: expected a <base>.snapshot.signed.json file`)
  return `${event.slice(0, -'.snapshot.signed.json'.length)}.snapshot.ots`
}

async function submit(fetch: PostDigest, calendar: string, digest: Uint8Array): Promise<Timestamp> {
  const response = await fetch(`${calendar.replace(/\/+$/, '')}/digest`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.opentimestamps.v1', 'Content-Type': 'application/octet-stream' },
    body: digest,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.length > MAX_RESPONSE_BYTES) throw new Error(`answer of ${body.length} bytes is too large`)
  return parseTimestamp(body)
}

/**
 * `archiver stamp <file.snapshot.signed.json>`: seals the `id` of a signed `snapshot` event with OpenTimestamps
 * (docs/spec/06, "Sello de tiempo", step 1). The `id` commits to `x`, and `x` to every event of the file. As the
 * reference client does, a random nonce is appended and hashed before submitting, so the calendars never learn
 * the `id`; the digest goes to every calendar at once and their answers are merged into one `.ots`, which is
 * pending until a calendar's transaction confirms. One calendar that fails is reported; it throws only when none
 * answered. An existing `.ots` is never overwritten: the next step upgrades it, it does not replace it.
 */
export async function runStamp(options: StampOptions, deps: StampDeps): Promise<StampResult> {
  if (options.calendars.length === 0) throw new Error('at least one calendar is needed to stamp')
  const ots = otsPath(options.event)
  const event = JSON.parse(await readFile(options.event, 'utf8')) as SignedEvent
  if (event.kind !== KIND.SNAPSHOT) throw new Error(`${options.event}: not a snapshot event (kind ${event.kind})`)
  if (!verifyEvent(event)) throw new Error(`${options.event}: invalid id or signature`)
  const id = Buffer.from(event.id, 'hex')

  if (await exists(ots)) {
    const { digest } = parseDetached(await readFile(ots))
    if (!Buffer.from(digest).equals(id)) throw new Error(`${ots} seals another digest, not the id ${event.id}`)
    deps.log(`${ots}: already stamped, id ${event.id}`)
    return { ots, id: event.id, accepted: [], rejected: [] }
  }

  const nonce = deps.random(16)
  const commitment = createHash('sha256').update(id).update(nonce).digest()
  const results = await Promise.allSettled(options.calendars.map((calendar) => submit(deps.fetch, calendar, commitment)))
  const merged: Timestamp = { attestations: [], ops: [] }
  const accepted: string[] = []
  const rejected: StampResult['rejected'] = []
  results.forEach((result, i) => {
    const calendar = options.calendars[i]!
    if (result.status === 'fulfilled') {
      merged.attestations.push(...result.value.attestations)
      merged.ops.push(...result.value.ops)
      accepted.push(calendar)
      deps.log(`${calendar}: accepted ${event.id}`)
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      rejected.push({ calendar, reason })
      deps.log(`${calendar}: rejected (${reason})`)
    }
  })
  if (accepted.length === 0) throw new Error(`no calendar accepted ${event.id}`)

  const timestamp: Timestamp = {
    attestations: [],
    ops: [[{ op: 'append', arg: nonce }, { attestations: [], ops: [[{ op: 'sha256' }, merged]] }]],
  }
  await writeFile(ots, serializeDetached(id, timestamp), { flag: 'wx' })
  deps.log(`${ots}: pending in ${accepted.length} calendar(s)`)
  return { ots, id: event.id, accepted, rejected }
}
