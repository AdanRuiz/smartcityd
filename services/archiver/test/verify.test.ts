import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serializeDetached, type Timestamp } from '../src/ots.js'
import { blockHash, fetchHeader, verifyFile, verifyTimestamp, type GetBlock, type VerifyDeps } from '../src/verify.js'

// Bitcoin's genesis block (height 0): a real header, so byte order, hash and proof of work are checked for real.
const GENESIS = Buffer.from(
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c',
  'hex',
)
const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
const GENESIS_TIME = 1_231_006_505
const MERKLE_ROOT = GENESIS.subarray(36, 68)

const bitcoin = (height: number): Timestamp => ({ attestations: [{ type: 'bitcoin', height }], ops: [] })
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest()

type Answer = { hash: string; header: Uint8Array } | 'down'

/** Esplora APIs over `fetch`: each origin answers its own block for every height, or is down. */
function esploras(answers: Record<string, Answer>) {
  const asked: string[] = []
  const get: GetBlock = async (url) => {
    asked.push(url)
    const { origin, pathname } = new URL(url)
    const answer = answers[origin]
    if (answer === undefined || answer === 'down') throw new Error('connection refused')
    if (/^\/api\/block-height\/\d+$/.test(pathname)) return new Response(answer.hash)
    if (pathname === `/api/block/${answer.hash}/header`) return new Response(Buffer.from(answer.header).toString('hex'))
    return new Response('not found', { status: 404 })
  }
  return { get, asked, urls: Object.keys(answers).map((o) => `${o}/api/`) }
}

function deps(get: GetBlock): VerifyDeps & { logs: string[] } {
  const logs: string[] = []
  return { fetch: get, log: (line) => logs.push(line), logs }
}

const genesis: Answer = { hash: GENESIS_HASH, header: GENESIS }

describe('block headers', () => {
  it('hashes a header to the hash Bitcoin shows', () => {
    expect(blockHash(GENESIS)).toBe(GENESIS_HASH)
  })

  it('accepts a header that hashes to the block and meets its proof of work', async () => {
    const { get, asked } = esploras({ 'https://e.example': genesis })
    expect(Buffer.from(await fetchHeader(get, 'https://e.example/api/', 0)).equals(GENESIS)).toBe(true)
    expect(asked).toEqual(['https://e.example/api/block-height/0', `https://e.example/api/block/${GENESIS_HASH}/header`])
  })

  it('refuses a header that does not hash to the block the API named', async () => {
    const forged = Buffer.from(GENESIS)
    forged.writeUInt8(forged.readUInt8(40) ^ 1, 40)
    const { get } = esploras({ 'https://e.example': { hash: GENESIS_HASH, header: forged } })
    await expect(fetchHeader(get, 'https://e.example/api', 0)).rejects.toThrow(/does not hash/)
  })

  it('refuses a made-up header that was not mined, even if the API names its hash', async () => {
    const forged = Buffer.from(GENESIS)
    forged.writeUInt8(forged.readUInt8(40) ^ 1, 40)
    const { get } = esploras({ 'https://e.example': { hash: blockHash(forged), header: forged } })
    await expect(fetchHeader(get, 'https://e.example/api', 0)).rejects.toThrow(/proof of work/)
  })
})

describe('archiver --verify (SNAP-7)', () => {
  it('verifies an attestation whose message is the merkle root of the block, with the block time', async () => {
    const { get, urls } = esploras({ 'https://a.example': genesis, 'https://b.example': genesis })
    const result = await verifyTimestamp(MERKLE_ROOT, bitcoin(0), urls, deps(get))
    expect(result).toEqual({ verified: [{ height: 0, time: GENESIS_TIME }], unknown: [] })
  })

  it('follows the operations of the proof to the attested message', async () => {
    // sha256(x) = merkle root cannot be built, so the root is reached by prepending its first half to its second.
    const ts: Timestamp = { attestations: [], ops: [[{ op: 'prepend', arg: MERKLE_ROOT.subarray(0, 16) }, bitcoin(0)]] }
    const { get, urls } = esploras({ 'https://a.example': genesis })
    const result = await verifyTimestamp(MERKLE_ROOT.subarray(16), ts, urls, deps(get))
    expect(result.verified).toEqual([{ height: 0, time: GENESIS_TIME }])
  })

  it('refuses a proof whose block has another merkle root', async () => {
    const { get, urls } = esploras({ 'https://a.example': genesis })
    await expect(verifyTimestamp(sha256(Buffer.from('other')), bitcoin(0), urls, deps(get))).rejects.toThrow(/does not contain the commitment/)
  })

  it('refuses when the Esploras answer different headers for the same height', async () => {
    // A lying API hands back another mined header (block 1) as if it were at height 0.
    const block1 = Buffer.from(
      '010000006fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000982051fd1e4ba744bbbe680e1fee14677ba1a3c3540bf7b1cdb606e857233e0e61bc6649ffff001d01e36299',
      'hex',
    )
    const { get, urls } = esploras({ 'https://a.example': genesis, 'https://b.example': { hash: blockHash(block1), header: block1 } })
    await expect(verifyTimestamp(MERKLE_ROOT, bitcoin(0), urls, deps(get))).rejects.toThrow(/different headers/)
  })

  it('counts on the Esploras that answer when one is down', async () => {
    const { get, urls } = esploras({ 'https://a.example': 'down', 'https://b.example': genesis })
    const d = deps(get)
    const result = await verifyTimestamp(MERKLE_ROOT, bitcoin(0), urls, d)
    expect(result.verified).toEqual([{ height: 0, time: GENESIS_TIME }])
    expect(d.logs.some((l) => l.includes('https://a.example/api: connection refused'))).toBe(true)
  })

  it('fails when no Esplora answers, and leaves the attestation unknown rather than refuted', async () => {
    const { get, urls } = esploras({ 'https://a.example': 'down' })
    await expect(verifyTimestamp(MERKLE_ROOT, bitcoin(0), urls, deps(get))).rejects.toThrow(/no Esplora answered/)
  })

  it('fails on a proof that is still pending', async () => {
    const ts: Timestamp = { attestations: [{ type: 'pending', uri: 'https://a.pool.opentimestamps.org' }], ops: [] }
    const { get, urls, asked } = esploras({ 'https://a.example': genesis })
    await expect(verifyTimestamp(MERKLE_ROOT, ts, urls, deps(get))).rejects.toThrow(/run archiver upgrade first/)
    expect(asked).toEqual([])
  })

  it('verifies the proof in a .ots file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archiver-verify-'))
    const ots = join(dir, 'sc_mx-gdl_2025-10-09.snapshot.ots')
    await writeFile(ots, serializeDetached(MERKLE_ROOT, bitcoin(0)))
    const { get, urls } = esploras({ 'https://a.example': genesis })
    const d = deps(get)
    expect((await verifyFile(ots, urls, d)).verified).toEqual([{ height: 0, time: GENESIS_TIME }])
    expect(d.logs.at(-1)).toBe(`${ots}: existed before Bitcoin block 0 (2009-01-03T18:15:05.000Z)`)
  })
})
