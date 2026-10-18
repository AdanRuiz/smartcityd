import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { attestations, parseDetached, type Timestamp } from './ots.js'
import { REQUEST_TIMEOUT_MS } from './relays.js'

/**
 * Esplora APIs asked for block headers by default: two operators. Any Esplora works with `--esplora`, including one
 * in front of your own Bitcoin node (electrs), which is the only source that needs no trust.
 */
export const DEFAULT_ESPLORAS = ['https://blockstream.info/api', 'https://mempool.space/api']

export type GetBlock = (url: string, init: { signal: AbortSignal }) => Promise<Response>

export interface VerifyDeps {
  fetch: GetBlock
  log: (line: string) => void
}

export interface VerifyResult {
  /** Bitcoin blocks whose merkle root is the attested message, with the block time (Unix seconds), lowest first. */
  verified: { height: number; time: number }[]
  /** Bitcoin attestations no Esplora could answer for; neither verified nor refuted. */
  unknown: { height: number; reason: string }[]
}

const trim = (url: string) => url.replace(/\/+$/, '')
const sha256d = (b: Uint8Array) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest()

/** Bitcoin shows block hashes as the double SHA-256 of the header, byte-reversed. */
export function blockHash(header: Uint8Array): string {
  return Buffer.from(sha256d(header)).reverse().toString('hex')
}

/** The target encoded in the compact `nBits` field: the block hash, read as a number, may not exceed it. */
function target(bits: number): bigint {
  const exponent = bits >>> 24
  const mantissa = BigInt(bits & 0x007fffff)
  if (bits & 0x00800000) return 0n
  return exponent <= 3 ? mantissa >> BigInt(8 * (3 - exponent)) : mantissa << BigInt(8 * (exponent - 3))
}

async function text(fetch: GetBlock, url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.text()
  // A hash or a header is under 200 characters; anything far larger is not an answer.
  if (body.length > 1000) throw new Error('answer too large')
  return body.trim()
}

/**
 * The 80-byte header of the block at `height` according to one Esplora (`GET /block-height/<h>`, then
 * `GET /block/<hash>/header`). The header must hash to the hash the API gave and meet the proof of work of its own
 * `nBits`, so the API cannot hand back a header it made up without mining it.
 */
export async function fetchHeader(fetch: GetBlock, esplora: string, height: number): Promise<Uint8Array> {
  const base = trim(esplora)
  const hash = await text(fetch, `${base}/block-height/${height}`)
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('block-height did not answer a block hash')
  const headerHex = await text(fetch, `${base}/block/${hash}/header`)
  if (!/^[0-9a-f]{160}$/.test(headerHex)) throw new Error('block header is not 80 bytes of hex')
  const header = Buffer.from(headerHex, 'hex')
  if (blockHash(header) !== hash) throw new Error(`header does not hash to block ${hash}`)
  const t = target(header.readUInt32LE(72))
  if (t === 0n || BigInt(`0x${hash}`) > t) throw new Error(`block ${hash} does not meet its proof of work`)
  return header
}

/**
 * Checks every Bitcoin attestation of a proof of `digest` against block headers (SNAP-7; as
 * `BitcoinBlockHeaderAttestation.verify_against_blockheader` in python-opentimestamps): the attested message must be
 * the merkle root of the block at that height. Every Esplora is asked; those that answer must agree on the header,
 * and one that is down only lowers the count. Throws if an attestation is refuted (another merkle root, or Esploras
 * that disagree) or if none could be verified; pending and unknown attestations do not count.
 */
export async function verifyTimestamp(
  digest: Uint8Array,
  timestamp: Timestamp,
  esploras: string[],
  deps: VerifyDeps,
): Promise<VerifyResult> {
  if (esploras.length === 0) throw new Error('at least one --esplora is needed to verify')
  const verified: VerifyResult['verified'] = []
  const unknown: VerifyResult['unknown'] = []
  const seen = new Set<string>()

  for (const { attestation, msg } of attestations(timestamp, digest)) {
    if (attestation.type !== 'bitcoin') continue
    const { height } = attestation
    const key = `${height}:${Buffer.from(msg).toString('hex')}`
    if (seen.has(key)) continue
    seen.add(key)
    if (msg.length !== 32) throw new Error(`Bitcoin block ${height}: attested message is not 32 bytes`)

    const headers = new Map<string, Uint8Array>()
    const failures: string[] = []
    for (const esplora of esploras) {
      try {
        const header = await fetchHeader(deps.fetch, esplora, height)
        headers.set(trim(esplora), header)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failures.push(`${trim(esplora)}: ${reason}`)
        deps.log(`Bitcoin block ${height}: ${trim(esplora)}: ${reason}`)
      }
    }
    if (headers.size === 0) {
      unknown.push({ height, reason: failures.join('; ') })
      continue
    }
    const distinct = new Set([...headers.values()].map((h) => Buffer.from(h).toString('hex')))
    if (distinct.size > 1) throw new Error(`Bitcoin block ${height}: the Esploras answer different headers (${[...headers.keys()].join(', ')})`)
    const header = headers.values().next().value!
    // The merkle root sits in the header at bytes 36–68, in the byte order the proof produces.
    if (Buffer.compare(Buffer.from(header.subarray(36, 68)), Buffer.from(msg)) !== 0) {
      throw new Error(`Bitcoin block ${height} does not contain the commitment: its merkle root is another`)
    }
    const time = Buffer.from(header).readUInt32LE(68)
    verified.push({ height, time })
    deps.log(`Bitcoin block ${height}: verified (${new Date(time * 1000).toISOString()}, ${[...headers.keys()].join(', ')})`)
  }

  verified.sort((a, b) => a.height - b.height)
  if (verified.length === 0) {
    throw new Error(unknown.length > 0 ? 'no Esplora answered for the attested blocks; try again or pass --esplora' : 'no Bitcoin attestation to verify; run archiver upgrade first')
  }
  return { verified, unknown }
}

/** `--verify` on a `.ots` file: the same check on the proof it holds. */
export async function verifyFile(ots: string, esploras: string[], deps: VerifyDeps): Promise<VerifyResult> {
  const { digest, timestamp } = parseDetached(await readFile(ots))
  const result = await verifyTimestamp(digest, timestamp, esploras, deps)
  deps.log(`${ots}: existed before Bitcoin block ${result.verified[0]!.height} (${new Date(result.verified[0]!.time * 1000).toISOString()})`)
  return result
}
