import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CHUNK_SIZE, MAX_LINKS, cidString, fileCid } from '../src/ipfs.js'

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest()
const rawCid = (data: Uint8Array) => Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), sha256(data)])

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
function decodeCid(text: string): Buffer {
  expect(text[0]).toBe('b')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of text.slice(1)) {
    value = (value << 5) | BASE32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return Buffer.from(out)
}

describe('IPFS CID (DIST-1)', () => {
  it('matches the well-known CID of an empty file', () => {
    expect(fileCid(new Uint8Array(0))).toBe('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')
  })

  it('encodes multibase base32 and round-trips', () => {
    const cid = rawCid(Buffer.from('hola'))
    expect(decodeCid(cidString(cid)).equals(cid)).toBe(true)
  })

  it('gives a single raw block for a file of one chunk', () => {
    const file = new Uint8Array(CHUNK_SIZE).map((_, i) => i % 251)
    expect(decodeCid(fileCid(file)).equals(rawCid(file))).toBe(true)
  })

  it('links the raw chunks from a dag-pb UnixFS file node', () => {
    const file = new Uint8Array(CHUNK_SIZE * 2 + 10).map((_, i) => (i * 7) % 256)
    const cid = decodeCid(fileCid(file))
    expect([...cid.subarray(0, 4)]).toEqual([0x01, 0x70, 0x12, 0x20])
    // The block is not in the CID, so rebuild what it must be and compare hashes.
    const chunks = [file.subarray(0, CHUNK_SIZE), file.subarray(CHUNK_SIZE, 2 * CHUNK_SIZE), file.subarray(2 * CHUNK_SIZE)]
    // PBLink: Hash (CID), Name "" and Tsize; 262144 is the varint 80 80 10.
    const link = (c: Uint8Array) => {
      const tsize = c.length === CHUNK_SIZE ? [0x80, 0x80, 0x10] : [c.length]
      const body = Buffer.concat([Buffer.from([0x0a, 0x24]), rawCid(c), Buffer.from([0x12, 0x00, 0x18, ...tsize])])
      return Buffer.concat([Buffer.from([0x12, body.length]), body])
    }
    // UnixFS: Type File, filesize 524298, blocksizes 262144, 262144, 10.
    const unixfs = Buffer.from([0x08, 0x02, 0x18, 0x8a, 0x80, 0x20, 0x20, 0x80, 0x80, 0x10, 0x20, 0x80, 0x80, 0x10, 0x20, 0x0a])
    const block = Buffer.concat([...chunks.map(link), Buffer.from([0x0a, unixfs.length]), unixfs])
    expect(cid.subarray(4).equals(sha256(block))).toBe(true)
  })

  it('adds a level after 174 chunks', () => {
    const one = fileCid(new Uint8Array(CHUNK_SIZE * MAX_LINKS))
    const more = fileCid(new Uint8Array(CHUNK_SIZE * MAX_LINKS + 1))
    expect(decodeCid(one)[1]).toBe(0x70)
    expect(decodeCid(more)[1]).toBe(0x70)
    expect(one).not.toBe(more)
  })
})
