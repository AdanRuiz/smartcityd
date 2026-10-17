import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KIND } from '@smartcity/schemas'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import {
  attestations,
  parseDetached,
  parseTimestamp,
  serializeDetached,
  serializeTimestamp,
  type Timestamp,
} from '../src/ots.js'
import { runStamp, type PostDigest, type StampDeps } from '../src/stamp.js'

const sha256 = (...parts: Uint8Array[]) => parts.reduce((h, p) => h.update(p), createHash('sha256')).digest()
const pending = (uri: string): Timestamp => ({ attestations: [{ type: 'pending', uri }], ops: [] })

describe('OpenTimestamps format', () => {
  it('serializes attestations like the reference client', () => {
    // Vectors of python-opentimestamps, `tests/core/test_timestamp.py`.
    const tag = Buffer.from('83dfe30d2ef90c8e0706', 'hex')
    const foobar = Buffer.concat([Buffer.from([0x00]), tag, Buffer.from('foobar')])
    const barfoo = Buffer.concat([Buffer.from([0x00]), tag, Buffer.from('barfoo')])
    expect(Buffer.from(serializeTimestamp(pending('foobar')))).toEqual(foobar)
    const two: Timestamp = { attestations: [{ type: 'pending', uri: 'barfoo' }, { type: 'pending', uri: 'foobar' }], ops: [] }
    expect(Buffer.from(serializeTimestamp(two))).toEqual(Buffer.concat([Buffer.from([0xff]), barfoo, foobar]))
    expect(parseTimestamp(serializeTimestamp(two))).toEqual(two)
  })

  it('round-trips a detached proof with operations and a Bitcoin attestation', () => {
    const digest = sha256(Buffer.from('snapshot'))
    const ts: Timestamp = {
      attestations: [],
      ops: [
        [{ op: 'append', arg: Uint8Array.from([1, 2, 3]) }, { attestations: [{ type: 'bitcoin', height: 917_123 }], ops: [] }],
        [{ op: 'prepend', arg: Uint8Array.from([9]) }, { attestations: [], ops: [[{ op: 'sha256' }, pending('https://a.example')]] }],
      ],
    }
    const bytes = serializeDetached(digest, ts)
    expect(Buffer.from(bytes.subarray(0, 32)).toString('latin1')).toBe('\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94\x01')
    const parsed = parseDetached(bytes)
    expect(Buffer.from(parsed.digest)).toEqual(digest)
    expect(parsed.timestamp).toEqual(ts)
    expect(attestations(parsed.timestamp, digest)).toEqual([
      { attestation: { type: 'bitcoin', height: 917_123 }, msg: Buffer.concat([digest, Buffer.from([1, 2, 3])]) },
      { attestation: { type: 'pending', uri: 'https://a.example' }, msg: sha256(Buffer.from([9]), digest) },
    ])
  })

  it('rejects malformed proofs', () => {
    const good = serializeTimestamp(pending('https://a.example'))
    expect(() => parseTimestamp(Buffer.concat([good, Buffer.from([0])]))).toThrow(/trailing/)
    expect(() => parseTimestamp(good.subarray(0, good.length - 1))).toThrow(/truncated/)
    expect(() => parseTimestamp(Uint8Array.from([0x42]))).toThrow(/unknown operation/)
    expect(() => parseTimestamp(serializeTimestamp(pending('https://a.example/"x"')))).toThrow(/calendar URI/)
    expect(() => parseDetached(Buffer.concat([Buffer.from('not ots'), good]))).toThrow(/not an OpenTimestamps/)
  })
})

/** A signed `snapshot` event as `archiver publish` leaves it. */
async function signed() {
  const event = finalizeEvent({ kind: KIND.SNAPSHOT, tags: [['c', 'mx-gdl']], content: '{}', created_at: 1_760_200_000 }, generateSecretKey())
  const dir = await mkdtemp(join(tmpdir(), 'archiver-stamp-'))
  const path = join(dir, 'sc_mx-gdl_2025-10-09.snapshot.signed.json')
  await writeFile(path, JSON.stringify(event, null, 2) + '\n')
  return { event, path, ots: join(dir, 'sc_mx-gdl_2025-10-09.snapshot.ots') }
}

/** Calendars over `fetch`: each answers `POST /digest` with a prefix, a SHA-256 and a pending attestation. */
function calendars(answers: Record<string, 'pending' | 'garbage' | number | 'down'>) {
  const received: { origin: string; body: Uint8Array }[] = []
  const post: PostDigest = async (url, init) => {
    const { origin, pathname } = new URL(url)
    const answer = answers[origin]
    if (!answer || answer === 'down') throw new Error('connection refused')
    expect(pathname).toBe('/digest')
    expect(init.method).toBe('POST')
    received.push({ origin, body: init.body })
    if (typeof answer === 'number') return new Response('', { status: answer })
    const ts: Timestamp = {
      attestations: [],
      ops: [[{ op: 'prepend', arg: Buffer.from(origin) }, { attestations: [], ops: [[{ op: 'sha256' }, pending(origin)]] }]],
    }
    const bytes = serializeTimestamp(ts)
    return new Response(answer === 'garbage' ? Buffer.concat([bytes, Buffer.from([1])]) : bytes)
  }
  return { post, received }
}

const NONCE = Uint8Array.from({ length: 16 }, (_, i) => i)

function deps(post: PostDigest): StampDeps & { logs: string[] } {
  const logs: string[] = []
  return { fetch: post, random: () => Uint8Array.from(NONCE), log: (line) => logs.push(line), logs }
}

describe('archiver stamp (SNAP-7)', () => {
  it('seals the id of the snapshot in every calendar that answers, without sending the id itself', async () => {
    const { event, path, ots } = await signed()
    const { post, received } = calendars({ 'https://a.example': 'pending', 'https://b.example': 500, 'https://c.example': 'down', 'https://d.example': 'pending' })
    const result = await runStamp(
      { event: path, calendars: ['https://a.example', 'https://b.example/', 'https://c.example', 'https://d.example'] },
      deps(post),
    )
    expect(result.ots).toBe(ots)
    expect(result.accepted).toEqual(['https://a.example', 'https://d.example'])
    expect(result.rejected).toEqual([
      { calendar: 'https://b.example/', reason: 'HTTP 500' },
      { calendar: 'https://c.example', reason: 'connection refused' },
    ])

    const id = Buffer.from(event.id, 'hex')
    const commitment = sha256(id, NONCE)
    expect(received.map((r) => Buffer.from(r.body))).toEqual([commitment, commitment, commitment])

    const proof = parseDetached(await readFile(ots))
    expect(Buffer.from(proof.digest)).toEqual(id)
    expect(attestations(proof.timestamp, proof.digest)).toEqual(
      ['https://a.example', 'https://d.example'].map((origin) => ({
        attestation: { type: 'pending', uri: origin },
        msg: sha256(Buffer.from(origin), commitment),
      })),
    )
  })

  it('never overwrites a proof: a later run reports it without contacting the calendars', async () => {
    const { path, ots } = await signed()
    await runStamp({ event: path, calendars: ['https://a.example'] }, deps(calendars({ 'https://a.example': 'pending' }).post))
    const first = await readFile(ots)
    const { post, received } = calendars({ 'https://a.example': 'pending' })
    const again = deps(post)
    await runStamp({ event: path, calendars: ['https://a.example'] }, again)
    expect(received).toEqual([])
    expect(await readFile(ots)).toEqual(first)
    expect(again.logs.at(-1)).toMatch(/already stamped/)
  })

  it('writes nothing when no calendar gives a valid proof', async () => {
    const { path, ots } = await signed()
    const { post } = calendars({ 'https://a.example': 'garbage', 'https://b.example': 503 })
    await expect(runStamp({ event: path, calendars: ['https://a.example', 'https://b.example'] }, deps(post))).rejects.toThrow(
      /no calendar accepted/,
    )
    await expect(readFile(ots)).rejects.toThrow(/ENOENT/)
  })

  it('stamps only valid signed snapshot events', async () => {
    const { event, path } = await signed()
    const { post, received } = calendars({ 'https://a.example': 'pending' })
    const unsigned = path.replace(/\.signed\.json$/, '.json')
    await writeFile(unsigned, JSON.stringify(event))
    await expect(runStamp({ event: unsigned, calendars: ['https://a.example'] }, deps(post))).rejects.toThrow(/signed\.json/)
    await writeFile(path, JSON.stringify({ ...event, content: '{"v":1}' }))
    await expect(runStamp({ event: path, calendars: ['https://a.example'] }, deps(post))).rejects.toThrow(/invalid id/)
    await expect(runStamp({ event: path, calendars: [] }, deps(post))).rejects.toThrow(/calendar/)
    expect(received).toEqual([])
  })
})
