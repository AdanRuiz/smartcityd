import { readFile, writeFile } from 'node:fs/promises'
import { KIND, validateEvent, type SignedEvent } from '@smartcity/schemas'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { REQUEST_TIMEOUT_MS, httpBase, wsUrl } from './relays.js'
import { exists, readPublished } from './snapshot.js'

export type Post = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>

export interface PublishOptions {
  /** Path of the unsigned `<base>.snapshot.json` written by `archiver snapshot` or `addendum`. */
  event: string
  /** Relays that receive the signed event through `POST /v1/events` (docs/spec/07). */
  relays: string[]
}

export interface PublishDeps {
  fetch: Post
  /** Seconds: the `created_at` of the signature. */
  now: number
  /** Asked only when the event is not signed yet, so a retry does not need the key (ID-4: the archiver's own key). */
  secretKey: () => Promise<Uint8Array>
  log: (line: string) => void
}

export interface PublishResult {
  event: SignedEvent
  /** Path of `<base>.snapshot.signed.json`. */
  signed: string
  accepted: string[]
  rejected: { relay: string; reason: string }[]
}

/** `sc_<city>_<day>[_a<N>].snapshot.json` → its archive and the signed copy next to it. */
function siblings(event: string) {
  if (!event.endsWith('.snapshot.json')) throw new Error(`${event}: expected a <base>.snapshot.json file`)
  const base = event.slice(0, -'.snapshot.json'.length)
  return { archive: `${base}.ndjson.gz`, signed: `${base}.snapshot.signed.json` }
}

/** The tags and content of a signed event are those of its template, byte for byte. */
function sameDraft(a: { kind: number; tags: string[][]; content: string }, b: { kind: number; tags: string[][]; content: string }) {
  return a.kind === b.kind && a.content === b.content && JSON.stringify(a.tags) === JSON.stringify(b.tags)
}

/**
 * Signs the `snapshot` event once (DIST-2). The archive is checked against the `x` and `file.x` of the template
 * first (SNAP-6), so the signature never vouches for a file that changed. The signed event is kept next to the
 * template and reused on later runs: signing again would give another `id`, and the OTS seal and the relays that
 * already hold the first one refer to that `id`.
 */
async function signOnce(path: string, deps: PublishDeps): Promise<{ event: SignedEvent; signed: string }> {
  const { archive, signed } = siblings(path)
  const template = JSON.parse(await readFile(path, 'utf8')) as { kind: number; tags: string[][]; content: string }
  if (template.kind !== KIND.SNAPSHOT) throw new Error(`${path}: not a snapshot event (kind ${template.kind})`)
  await readPublished({ archive, event: path })

  if (await exists(signed)) {
    const event = JSON.parse(await readFile(signed, 'utf8')) as SignedEvent
    if (!verifyEvent(event) || !sameDraft(event, template)) {
      throw new Error(`${signed} is not a valid signature of ${path}; remove it to sign again`)
    }
    deps.log(`${signed}: already signed, id ${event.id}`)
    return { event, signed }
  }

  const sk = await deps.secretKey()
  let event: SignedEvent
  try {
    const { id, pubkey, created_at, kind, tags, content, sig } = finalizeEvent(
      { kind: template.kind, tags: template.tags, content: template.content, created_at: deps.now },
      sk,
    )
    event = { id, pubkey, created_at, kind, tags, content, sig }
    deps.log(`${signed}: signed by ${getPublicKey(sk)}, id ${event.id}`)
  } finally {
    sk.fill(0)
  }
  const valid = validateEvent(event)
  if (!valid.ok) throw new Error(`signed snapshot does not validate: ${valid.errors.join('; ')}`)
  await writeFile(signed, JSON.stringify(event, null, 2) + '\n', { flag: 'wx' })
  return { event, signed }
}

async function post(fetch: Post, relay: string, event: SignedEvent): Promise<void> {
  const url = `${httpBase(relay)}/v1/events`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  let body: { ok?: unknown; reason?: unknown } = {}
  try {
    body = (await response.json()) as typeof body
  } catch {
    // A relay that answers without JSON is judged by its status alone.
  }
  if (!response.ok || body.ok !== true) {
    throw new Error(typeof body.reason === 'string' ? body.reason : `HTTP ${response.status}`)
  }
}

/**
 * Sends a signed event to every relay at the same time. One that refuses or fails is reported, since none is
 * mandatory; it throws only when no relay accepted the event, naming `kept`, the file to publish it from later.
 */
export async function broadcast(
  relays: string[],
  event: SignedEvent,
  kept: string,
  deps: Pick<PublishDeps, 'fetch' | 'log'>,
): Promise<Pick<PublishResult, 'accepted' | 'rejected'>> {
  const results = await Promise.allSettled(relays.map((relay) => post(deps.fetch, relay, event)))
  const accepted: string[] = []
  const rejected: PublishResult['rejected'] = []
  results.forEach((result, i) => {
    const relay = relays[i]!
    if (result.status === 'fulfilled') {
      accepted.push(wsUrl(relay))
      deps.log(`${relay}: accepted ${event.id}`)
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      rejected.push({ relay, reason })
      deps.log(`${relay}: rejected (${reason})`)
    }
  })
  if (accepted.length === 0) throw new Error(`no relay accepted ${event.id}; ${kept} is kept to publish it later`)
  return { accepted, rejected }
}

/**
 * `archiver publish <file.snapshot.json> --relay <url>… --key <ncryptsec>`: signs the `snapshot` event of a written
 * file and sends it to every relay at the same time (`broadcast`). Running it again sends the same signed event, so
 * a relay that was down can be caught up later.
 */
export async function runPublish(options: PublishOptions, deps: PublishDeps): Promise<PublishResult> {
  if (options.relays.length === 0) throw new Error('at least one --relay is needed to publish')
  const { event, signed } = await signOnce(options.event, deps)
  return { event, signed, ...(await broadcast(options.relays, event, signed, deps)) }
}
