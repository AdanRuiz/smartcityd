import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KIND, NOSTR_KIND, type SignedEvent } from '@smartcity/schemas'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { bitcoinBranch, runAttest } from '../src/attest.js'
import { attestations, parseDetached, serializeDetached, type Timestamp } from '../src/ots.js'
import type { Post, PublishDeps } from '../src/publish.js'

const NOW = 1_760_200_000
const NONCE = Uint8Array.from({ length: 16 }, (_, i) => i)
const pending = (uri: string): Timestamp => ({ attestations: [{ type: 'pending', uri }], ops: [] })
const bitcoin = (height: number): Timestamp => ({ attestations: [{ type: 'bitcoin', height }], ops: [] })
const via = (tag: string, next: Timestamp): Timestamp => ({
  attestations: [],
  ops: [[{ op: 'prepend', arg: Buffer.from(tag) }, { attestations: [], ops: [[{ op: 'sha256' }, next]] }]],
})

/** A proof as `archiver stamp` and `upgrade` leave it: the nonce, then one branch per calendar. */
function proof(...calendars: Timestamp[]): Timestamp {
  const merged: Timestamp = { attestations: [], ops: calendars.flatMap((c) => c.ops) }
  return { attestations: [], ops: [[{ op: 'append', arg: NONCE }, { attestations: [], ops: [[{ op: 'sha256' }, merged]] }]] }
}

/** A signed snapshot event and its `.ots` next to it, with the names `archiver publish` and `stamp` give them. */
async function stamped(ts: Timestamp, digestOf?: string) {
  const snapshot = finalizeEvent({ kind: KIND.SNAPSHOT, tags: [['c', 'mx-gdl']], content: '{}', created_at: NOW - 86_400 }, generateSecretKey())
  const dir = await mkdtemp(join(tmpdir(), 'archiver-attest-'))
  const base = join(dir, 'sc_mx-gdl_2025-10-09')
  await writeFile(`${base}.snapshot.signed.json`, JSON.stringify(snapshot))
  await writeFile(`${base}.snapshot.ots`, serializeDetached(Buffer.from(digestOf ?? snapshot.id, 'hex'), ts))
  return { snapshot, ots: `${base}.snapshot.ots`, signed: `${base}.ots.signed.json` }
}

function relays(verdicts: Record<string, boolean>) {
  const received: { origin: string; event: SignedEvent }[] = []
  const post: Post = async (url, init) => {
    const { origin, pathname } = new URL(url)
    if (!(origin in verdicts)) throw new Error('connection refused')
    expect(pathname).toBe('/v1/events')
    received.push({ origin, event: JSON.parse(init.body) as SignedEvent })
    return new Response(JSON.stringify(verdicts[origin] ? { ok: true } : { ok: false, reason: 'blocked: no' }), { status: verdicts[origin] ? 200 : 400 })
  }
  return { post, received }
}

function deps(post: Post, sk: Uint8Array, now = NOW): PublishDeps & { asked: () => number } {
  let asked = 0
  return { fetch: post, now, secretKey: async () => (asked++, Uint8Array.from(sk)), log: () => {}, asked: () => asked }
}

describe('bitcoinBranch', () => {
  it('keeps only the path to the lowest Bitcoin block and drops pending attestations', () => {
    const ts = proof(via('a', bitcoin(917_300)), via('b', pending('https://b.example')), via('c', bitcoin(917_200)))
    const branch = bitcoinBranch(ts)!
    expect(branch.height).toBe(917_200)
    expect(branch.timestamp).toEqual(proof(via('c', bitcoin(917_200))))
  })

  it('is null while every attestation is pending', () => {
    expect(bitcoinBranch(proof(via('a', pending('https://a.example'))))).toBeNull()
  })
})

describe('archiver attest (NIP-03, SNAP-7)', () => {
  it('publishes the completed proof as kind 1040 with the e and k tags of the snapshot', async () => {
    const { snapshot, ots, signed } = await stamped(proof(via('a', bitcoin(917_200)), via('b', pending('https://b.example'))))
    const sk = generateSecretKey()
    const { post, received } = relays({ 'https://a.example': true, 'https://b.example': false })
    const result = await runAttest({ ots, relays: ['wss://a.example', 'wss://b.example', 'wss://c.example'] }, deps(post, sk))

    const event = result.event
    expect(verifyEvent(event)).toBe(true)
    expect(event.kind).toBe(NOSTR_KIND.OPENTIMESTAMPS)
    expect(event.pubkey).toBe(getPublicKey(sk))
    expect(event.created_at).toBe(NOW)
    expect(event.tags).toEqual([['e', snapshot.id], ['k', String(KIND.SNAPSHOT)]])
    const published = parseDetached(Buffer.from(event.content, 'base64'))
    expect(Buffer.from(published.digest).toString('hex')).toBe(snapshot.id)
    expect(attestations(published.timestamp, published.digest).map((a) => a.attestation)).toEqual([{ type: 'bitcoin', height: 917_200 }])
    expect(result.height).toBe(917_200)
    expect(await readFile(signed, 'utf8')).toBe(JSON.stringify(event, null, 2) + '\n')
    expect(received.map((r) => r.event.id)).toEqual([event.id, event.id])
    expect(result.accepted).toEqual(['wss://a.example'])
    expect(result.rejected).toEqual([
      { relay: 'wss://b.example', reason: 'blocked: no' },
      { relay: 'wss://c.example', reason: 'connection refused' },
    ])
  })

  it('refuses a proof that is still pending, without asking for the key', async () => {
    const { ots, signed } = await stamped(proof(via('a', pending('https://a.example'))))
    const { post, received } = relays({ 'https://a.example': true })
    const d = deps(post, generateSecretKey())
    await expect(runAttest({ ots, relays: ['wss://a.example'] }, d)).rejects.toThrow(/still pending.*upgrade/)
    expect(d.asked()).toBe(0)
    expect(received).toEqual([])
    await expect(readFile(signed)).rejects.toThrow()
  })

  it('refuses a proof of another digest than the id of the snapshot', async () => {
    const { ots } = await stamped(proof(via('a', bitcoin(1))), 'ab'.repeat(32))
    const { post } = relays({ 'https://a.example': true })
    await expect(runAttest({ ots, relays: ['wss://a.example'] }, deps(post, generateSecretKey()))).rejects.toThrow(/another digest/)
  })

  it('signs only once: a later run resends the same event, and a copy for another proof is refused', async () => {
    const { ots } = await stamped(proof(via('a', bitcoin(917_200))))
    const sk = generateSecretKey()
    const first = deps(relays({}).post, sk)
    await expect(runAttest({ ots, relays: ['wss://a.example'] }, first)).rejects.toThrow(/no relay accepted.*ots\.signed\.json/)
    expect(first.asked()).toBe(1)

    const { post, received } = relays({ 'https://a.example': true })
    const again = deps(post, generateSecretKey(), NOW + 3600)
    const result = await runAttest({ ots, relays: ['wss://a.example'] }, again)
    expect(again.asked()).toBe(0)
    expect(result.event.pubkey).toBe(getPublicKey(sk))
    expect(received).toHaveLength(1)

    const { digest } = parseDetached(await readFile(ots))
    await writeFile(ots, serializeDetached(digest, proof(via('b', bitcoin(917_100)))))
    await expect(runAttest({ ots, relays: ['wss://a.example'] }, deps(post, sk))).rejects.toThrow(/remove it to sign again/)
  })

  it('needs a relay and a .snapshot.ots file', async () => {
    const { ots } = await stamped(proof(via('a', bitcoin(1))))
    const { post } = relays({})
    await expect(runAttest({ ots, relays: [] }, deps(post, generateSecretKey()))).rejects.toThrow(/--relay/)
    await expect(runAttest({ ots: `${ots}.json`, relays: ['wss://a.example'] }, deps(post, generateSecretKey()))).rejects.toThrow(/\.snapshot\.ots/)
  })
})
