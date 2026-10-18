import { readFile, writeFile } from 'node:fs/promises'
import { KIND, NOSTR_KIND, type SignedEvent } from '@smartcity/schemas'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { parseDetached, serializeDetached, type Timestamp } from './ots.js'
import { broadcast, type PublishDeps } from './publish.js'
import { exists } from './snapshot.js'

export interface AttestOptions {
  /** Path of `<base>.snapshot.ots`, completed by `archiver upgrade`. */
  ots: string
  /** Relays that receive the kind 1040 event through `POST /v1/events`. */
  relays: string[]
}

export interface AttestResult {
  event: SignedEvent
  /** Path of `<base>.ots.signed.json`. */
  signed: string
  /** Bitcoin block the published proof attests. */
  height: number
  accepted: string[]
  rejected: { relay: string; reason: string }[]
}

/** `sc_<city>_<day>[_a<N>].snapshot.ots` → the signed snapshot event it seals and the signed kind 1040 next to it. */
function siblings(ots: string) {
  if (!ots.endsWith('.snapshot.ots')) throw new Error(`${ots}: expected a <base>.snapshot.ots file`)
  const base = ots.slice(0, -'.snapshot.ots'.length)
  return { snapshot: `${base}.snapshot.signed.json`, signed: `${base}.ots.signed.json` }
}

/**
 * The branch of the proof that leads to its lowest Bitcoin attestation, alone: NIP-03 asks for a single Bitcoin
 * attestation and no pending ones, which are useless once it is in a block. Null while the proof is still pending.
 */
export function bitcoinBranch(ts: Timestamp): { height: number; timestamp: Timestamp } | null {
  let best: { height: number; timestamp: Timestamp } | null = null
  for (const a of ts.attestations) {
    if (a.type === 'bitcoin' && (!best || a.height < best.height)) best = { height: a.height, timestamp: { attestations: [a], ops: [] } }
  }
  for (const [op, next] of ts.ops) {
    const found = bitcoinBranch(next)
    if (found && (!best || found.height < best.height)) {
      best = { height: found.height, timestamp: { attestations: [], ops: [[op, found.timestamp]] } }
    }
  }
  return best
}

/** The Bitcoin branch of the proof in a saved kind 1040 `content`, if it seals `id`; null if it does not parse or seal it. */
function savedBranch(content: string, id: string): { height: number } | null {
  try {
    const { digest, timestamp } = parseDetached(Buffer.from(content, 'base64'))
    return Buffer.from(digest).toString('hex') === id ? bitcoinBranch(timestamp) : null
  } catch {
    return null
  }
}

/**
 * `archiver attest <file.snapshot.ots> --relay <url>… --key <ncryptsec>`: publishes the OpenTimestamps proof of a
 * `snapshot` event as kind 1040 (NIP-03; docs/spec/06, "Sello de tiempo", steps 2 and 3; SNAP-7), with the tag `e`
 * of the snapshot `id`, `k` with its kind, `c` with its city and the `.ots` in base64 as `content`. NIP-03 requires a
 * proof with a Bitcoin attestation, so a proof that is still pending is refused: run `archiver upgrade` first. Only the
 * branch to the lowest block is kept. The proof must seal the `id` of the signed snapshot next to it. As `publish`, it signs
 * once with the archiver's key (ID-4) and later runs resend that event as it is, even if `upgrade` changed the `.ots`
 * since; a saved copy that is not a valid signed proof of this snapshot is refused.
 * Whether the block really contains the commitment is `--verify`'s job.
 */
export async function runAttest(options: AttestOptions, deps: PublishDeps): Promise<AttestResult> {
  if (options.relays.length === 0) throw new Error('at least one --relay is needed to publish')
  const { snapshot: snapshotPath, signed } = siblings(options.ots)
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as SignedEvent
  if (snapshot.kind !== KIND.SNAPSHOT) throw new Error(`${snapshotPath}: not a snapshot event (kind ${snapshot.kind})`)
  if (!verifyEvent(snapshot)) throw new Error(`${snapshotPath}: invalid id or signature`)

  const city = snapshot.tags.find((t) => t[0] === 'c')?.[1]
  if (!city) throw new Error(`${snapshotPath}: snapshot event without a c tag`)
  // `c` lets relays store the proof under the snapshot's city, so `#c` queries and exports by city include it.
  const tags = [['e', snapshot.id], ['k', String(KIND.SNAPSHOT)], ['c', city]]

  const { digest, timestamp } = parseDetached(await readFile(options.ots))
  if (Buffer.from(digest).toString('hex') !== snapshot.id) throw new Error(`${options.ots} seals another digest, not the id ${snapshot.id}`)

  let event: SignedEvent
  let height: number
  if (await exists(signed)) {
    // Resend the saved event as it is. `upgrade` may have merged a lower block into the `.ots` since it was signed;
    // comparing with a branch rebuilt from it would refuse the event already out and force a second, different 1040.
    event = JSON.parse(await readFile(signed, 'utf8')) as SignedEvent
    const saved = event.kind === NOSTR_KIND.OPENTIMESTAMPS && JSON.stringify(event.tags) === JSON.stringify(tags) && verifyEvent(event)
    const branch = saved ? savedBranch(event.content, snapshot.id) : null
    if (!branch) throw new Error(`${signed} is not a valid signed proof of this snapshot; remove it to sign again`)
    height = branch.height
    deps.log(`${signed}: already signed, id ${event.id}, Bitcoin block ${height}`)
  } else {
    const branch = bitcoinBranch(timestamp)
    if (!branch) throw new Error(`${options.ots}: still pending, no Bitcoin attestation yet; run archiver upgrade first`)
    height = branch.height
    const content = Buffer.from(serializeDetached(digest, branch.timestamp)).toString('base64')
    const sk = await deps.secretKey()
    try {
      const { id, pubkey, created_at, kind, tags: t, content: c, sig } = finalizeEvent(
        { kind: NOSTR_KIND.OPENTIMESTAMPS, tags, content, created_at: deps.now },
        sk,
      )
      event = { id, pubkey, created_at, kind, tags: t, content: c, sig }
      deps.log(`${signed}: signed by ${getPublicKey(sk)}, id ${event.id}, Bitcoin block ${height}`)
    } finally {
      sk.fill(0)
    }
    await writeFile(signed, JSON.stringify(event, null, 2) + '\n', { flag: 'wx' })
  }

  return { event, signed, height, ...(await broadcast(options.relays, event, signed, deps)) }
}
