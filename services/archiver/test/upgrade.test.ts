import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { attestations, parseDetached, serializeDetached, serializeTimestamp, type Timestamp } from '../src/ots.js'
import { mergeTimestamp, runUpgrade, type GetTimestamp, type UpgradeDeps } from '../src/upgrade.js'

const sha256 = (...parts: Uint8Array[]) => parts.reduce((h, p) => h.update(p), createHash('sha256')).digest()
const pending = (uri: string): Timestamp => ({ attestations: [{ type: 'pending', uri }], ops: [] })
const ID = sha256(Buffer.from('snapshot event'))
const NONCE = Uint8Array.from({ length: 16 }, (_, i) => i)
const COMMITMENT = sha256(ID, NONCE)

/** What a calendar's `POST /digest` leaves under the commitment, as in `stamp.test.ts`. */
const branch = (origin: string): Timestamp => ({
  attestations: [],
  ops: [[{ op: 'prepend', arg: Buffer.from(origin) }, { attestations: [], ops: [[{ op: 'sha256' }, pending(origin)]] }]],
})
const leaf = (origin: string) => sha256(Buffer.from(origin), COMMITMENT)

/** A pending `.ots` as `archiver stamp` writes it, with one branch per calendar. */
async function stamped(origins: string[]) {
  const merged: Timestamp = { attestations: [], ops: origins.flatMap((o) => branch(o).ops) }
  const ts: Timestamp = {
    attestations: [],
    ops: [[{ op: 'append', arg: NONCE }, { attestations: [], ops: [[{ op: 'sha256' }, merged]] }]],
  }
  const dir = await mkdtemp(join(tmpdir(), 'archiver-upgrade-'))
  const ots = join(dir, 'sc_mx-gdl_2025-10-09.snapshot.ots')
  await writeFile(ots, serializeDetached(ID, ts))
  return { dir, ots }
}

/** Calendars over `fetch`: a confirmed one answers the path from its leaf to a block; the rest, a status. */
function calendars(answers: Record<string, number | 'down'>) {
  const asked: string[] = []
  const get: GetTimestamp = async (url) => {
    const { origin, pathname } = new URL(url)
    asked.push(url)
    const answer = answers[origin]
    if (answer === undefined || answer === 'down') throw new Error('connection refused')
    if (answer < 1000) return new Response('', { status: answer })
    expect(pathname).toBe(`/timestamp/${leaf(origin).toString('hex')}`)
    const upgraded: Timestamp = {
      attestations: [],
      ops: [[{ op: 'append', arg: Buffer.from('merkle') }, { attestations: [], ops: [[{ op: 'sha256' }, { attestations: [{ type: 'bitcoin', height: answer }], ops: [] }]] }]],
    }
    return new Response(serializeTimestamp(upgraded))
  }
  return { get, asked }
}

function deps(get: GetTimestamp): UpgradeDeps & { logs: string[] } {
  const logs: string[] = []
  return { fetch: get, log: (line) => logs.push(line), logs }
}

describe('mergeTimestamp', () => {
  it('joins branches with the same operation and keeps attestations once', () => {
    const into: Timestamp = { attestations: [{ type: 'pending', uri: 'https://a.example' }], ops: [[{ op: 'sha256' }, pending('x')]] }
    mergeTimestamp(into, {
      attestations: [{ type: 'pending', uri: 'https://a.example' }, { type: 'bitcoin', height: 7 }],
      ops: [[{ op: 'sha256' }, pending('y')], [{ op: 'append', arg: Uint8Array.from([1]) }, pending('z')]],
    })
    expect(into).toEqual({
      attestations: [{ type: 'pending', uri: 'https://a.example' }, { type: 'bitcoin', height: 7 }],
      ops: [
        [{ op: 'sha256' }, { attestations: [{ type: 'pending', uri: 'x' }, { type: 'pending', uri: 'y' }], ops: [] }],
        [{ op: 'append', arg: Uint8Array.from([1]) }, pending('z')],
      ],
    })
  })
})

describe('archiver upgrade (SNAP-7)', () => {
  it('completes the branch of every calendar that confirmed and keeps the others pending', async () => {
    const { dir, ots } = await stamped(['https://a.example', 'https://b.example', 'https://c.example'])
    const { get, asked } = calendars({ 'https://a.example': 917_200, 'https://b.example': 404, 'https://c.example': 'down' })
    const result = await runUpgrade({ ots, calendars: ['https://a.example/', 'https://b.example', 'https://c.example'] }, deps(get))
    expect(asked).toEqual(['https://a.example', 'https://b.example', 'https://c.example'].map((o) => `${o}/timestamp/${leaf(o).toString('hex')}`))
    expect(result).toEqual({
      ots,
      bitcoin: [917_200],
      upgraded: ['https://a.example'],
      pending: [
        { calendar: 'https://b.example', reason: 'not confirmed yet' },
        { calendar: 'https://c.example', reason: 'connection refused' },
      ],
    })

    const proof = parseDetached(await readFile(ots))
    expect(Buffer.from(proof.digest)).toEqual(ID)
    expect(attestations(proof.timestamp, proof.digest)).toEqual([
      { attestation: { type: 'pending', uri: 'https://a.example' }, msg: leaf('https://a.example') },
      { attestation: { type: 'bitcoin', height: 917_200 }, msg: sha256(leaf('https://a.example'), Buffer.from('merkle')) },
      { attestation: { type: 'pending', uri: 'https://b.example' }, msg: leaf('https://b.example') },
      { attestation: { type: 'pending', uri: 'https://c.example' }, msg: leaf('https://c.example') },
    ])
    expect(await readdir(dir)).toEqual(['sc_mx-gdl_2025-10-09.snapshot.ots'])

    // A second run asks again and adds nothing new to the branch already completed.
    const again = await runUpgrade({ ots, calendars: ['https://a.example'] }, deps(calendars({ 'https://a.example': 917_200 }).get))
    expect(again.bitcoin).toEqual([917_200])
    expect(attestations(parseDetached(await readFile(ots)).timestamp, ID)).toHaveLength(4)
  })

  it('leaves the file untouched while nothing confirmed', async () => {
    const { ots } = await stamped(['https://a.example'])
    const before = await readFile(ots)
    const d = deps(calendars({ 'https://a.example': 404 }).get)
    const result = await runUpgrade({ ots, calendars: ['https://a.example'] }, d)
    expect(result.bitcoin).toEqual([])
    expect(result.upgraded).toEqual([])
    expect(await readFile(ots)).toEqual(before)
    expect(d.logs.at(-1)).toMatch(/still pending/)
  })

  it('never contacts a calendar the proof names but the archiver did not allow', async () => {
    const { ots } = await stamped(['https://evil.example'])
    const { get, asked } = calendars({ 'https://evil.example': 1_000_000 })
    const result = await runUpgrade({ ots, calendars: ['https://a.example'] }, deps(get))
    expect(asked).toEqual([])
    expect(result.pending).toEqual([{ calendar: 'https://evil.example', reason: 'not an allowed calendar' }])
  })

  it('refuses an answer that is not a proof', async () => {
    const { ots } = await stamped(['https://a.example'])
    const before = await readFile(ots)
    const get: GetTimestamp = async () => new Response(Uint8Array.from([0x42]))
    const result = await runUpgrade({ ots, calendars: ['https://a.example'] }, deps(get))
    expect(result.pending[0]?.reason).toMatch(/unknown operation/)
    expect(await readFile(ots)).toEqual(before)
  })
})
