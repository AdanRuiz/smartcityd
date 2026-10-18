import { readFile, rename, writeFile } from 'node:fs/promises'
import { applyOp, attestations, parseDetached, parseTimestamp, serializeDetached, type Attestation, type Op, type Timestamp } from './ots.js'
import { REQUEST_TIMEOUT_MS } from './relays.js'

/** A calendar answer is a few hundred bytes; anything far larger is not a proof. */
const MAX_RESPONSE_BYTES = 10_000

export type GetTimestamp = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>

export interface UpgradeOptions {
  /** Path of `<base>.snapshot.ots`, written by `archiver stamp`. */
  ots: string
  /**
   * Calendars that may be asked. A pending attestation names its own calendar, but the proof is data: as the
   * reference client does with its whitelist, only these URLs are contacted, never whatever the file says.
   */
  calendars: string[]
}

export interface UpgradeDeps {
  fetch: GetTimestamp
  log: (line: string) => void
}

export interface UpgradeResult {
  ots: string
  /** Bitcoin block heights the proof now attests, lowest first. Empty while it is still pending. */
  bitcoin: number[]
  /** Calendars whose part of the proof was completed in this run. */
  upgraded: string[]
  /** Calendars that do not have the transaction confirmed yet, or did not answer. */
  pending: { calendar: string; reason: string }[]
}

const trim = (url: string) => url.replace(/\/+$/, '')
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

function opKey(op: Op): string {
  return 'arg' in op ? `${op.op}:${hex(op.arg)}` : op.op
}

function attestationKey(a: Attestation): string {
  if (a.type === 'pending') return `pending:${a.uri}`
  if (a.type === 'bitcoin') return `bitcoin:${a.height}`
  return `${a.tag}:${hex(a.payload)}`
}

/** Adds to `into` what `from` attests about the same message, as `Timestamp.merge` in the reference client. */
export function mergeTimestamp(into: Timestamp, from: Timestamp): void {
  const known = new Set(into.attestations.map(attestationKey))
  for (const a of from.attestations) {
    if (!known.has(attestationKey(a))) {
      into.attestations.push(a)
      known.add(attestationKey(a))
    }
  }
  for (const [op, next] of from.ops) {
    const same = into.ops.find(([existing]) => opKey(existing) === opKey(op))
    if (same) mergeTimestamp(same[1], next)
    else into.ops.push([op, next])
  }
}

/** Every node holding a pending attestation, with the message it commits to: what the calendar is asked for. */
function pendingNodes(ts: Timestamp, msg: Uint8Array): { node: Timestamp; msg: Uint8Array; uri: string }[] {
  return [
    ...ts.attestations.flatMap((a) => (a.type === 'pending' ? [{ node: ts, msg, uri: a.uri }] : [])),
    ...ts.ops.flatMap(([op, next]) => pendingNodes(next, applyOp(op, msg))),
  ]
}

async function ask(fetch: GetTimestamp, calendar: string, commitment: Uint8Array): Promise<Timestamp> {
  const response = await fetch(`${trim(calendar)}/timestamp/${hex(commitment)}`, {
    headers: { Accept: 'application/vnd.opentimestamps.v1' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status === 404) throw new Error('not confirmed yet')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.length > MAX_RESPONSE_BYTES) throw new Error(`answer of ${body.length} bytes is too large`)
  return parseTimestamp(body)
}

/**
 * `archiver upgrade <file.snapshot.ots>`: completes a pending proof once the calendars' Bitcoin transaction confirms
 * (docs/spec/06, "Sello de tiempo", step 3; SNAP-7). For each pending attestation of an allowed calendar it asks
 * `GET /timestamp/<commitment>` and merges the answer into that node, as `ots upgrade` does; pending attestations
 * stay, so a calendar that has not confirmed can still complete its part later. Calendars are asked one after the
 * other in the order of the proof. The `.ots` is replaced only when something was added, through a temporary file
 * so a failure never leaves half a proof. A calendar that answers 404 has not confirmed yet: run it again later.
 * Whether the attested block really contains the commitment is `--verify`'s job, not this one.
 */
export async function runUpgrade(options: UpgradeOptions, deps: UpgradeDeps): Promise<UpgradeResult> {
  const allowed = new Set(options.calendars.map(trim))
  const { digest, timestamp } = parseDetached(await readFile(options.ots))
  const upgraded: string[] = []
  const pending: UpgradeResult['pending'] = []

  for (const { node, msg, uri } of pendingNodes(timestamp, digest)) {
    const calendar = trim(uri)
    if (!allowed.has(calendar)) {
      pending.push({ calendar, reason: 'not an allowed calendar' })
      deps.log(`${calendar}: skipped, not an allowed calendar (--calendar)`)
      continue
    }
    try {
      const answer = await ask(deps.fetch, calendar, msg)
      mergeTimestamp(node, answer)
      upgraded.push(calendar)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      pending.push({ calendar, reason })
      deps.log(`${calendar}: ${reason}`)
    }
  }

  const bitcoin = [
    ...new Set(attestations(timestamp, digest).flatMap(({ attestation: a }) => (a.type === 'bitcoin' ? [a.height] : []))),
  ].sort((a, b) => a - b)
  for (const calendar of upgraded) deps.log(`${calendar}: upgraded`)

  if (upgraded.length > 0) {
    const tmp = `${options.ots}.tmp`
    await writeFile(tmp, serializeDetached(digest, timestamp))
    await rename(tmp, options.ots)
  }
  deps.log(
    bitcoin.length > 0
      ? `${options.ots}: attested in Bitcoin block ${bitcoin.join(', ')}`
      : `${options.ots}: still pending, run upgrade again later`,
  )
  return { ots: options.ots, bitcoin, upgraded, pending }
}
