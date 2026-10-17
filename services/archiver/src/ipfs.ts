import { createHash } from 'node:crypto'

// IPFS CID of a file (DIST-1), computed without a node or dependency, so it can go into the `snapshot` event before
// signing. It is the CID that `ipfs add --cid-version=1` gives with kubo's defaults: 256 KiB chunks as raw leaves,
// balanced UnixFS tree of at most 174 links per node, sha2-256. The archivist then pins the file with that command
// and gets the same CID (ADR-15); a file of one chunk is a single raw block (`bafkrei…`).

export const CHUNK_SIZE = 262_144
export const MAX_LINKS = 174
const RAW = 0x55
const DAG_PB = 0x70
const UNIXFS_FILE = 2

interface Node {
  cid: Uint8Array
  /** Bytes of this block and every block below it (dag-pb `Tsize`). */
  tsize: number
  /** File bytes under this node (UnixFS `blocksizes`). */
  fileSize: number
}

function varint(n: number): number[] {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80)
    n = Math.floor(n / 0x80)
  }
  out.push(n)
  return out
}

/** Protobuf field with wire type 0 (varint). */
const varintField = (field: number, n: number) => Buffer.from([field << 3, ...varint(n)])
/** Protobuf field with wire type 2 (length-delimited). */
const bytesField = (field: number, data: Uint8Array) =>
  Buffer.concat([Buffer.from([(field << 3) | 2, ...varint(data.length)]), data])

function cidV1(codec: number, block: Uint8Array): Uint8Array {
  const digest = createHash('sha256').update(block).digest()
  return Buffer.concat([Buffer.from([0x01, codec, 0x12, digest.length]), digest])
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** Multibase `b`: RFC 4648 base32, lowercase, no padding. */
export function cidString(cid: Uint8Array): string {
  let out = 'b'
  let bits = 0
  let value = 0
  for (const byte of cid) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

function leaf(chunk: Uint8Array): Node {
  return { cid: cidV1(RAW, chunk), tsize: chunk.length, fileSize: chunk.length }
}

/** dag-pb node (links first, then data) whose data is a UnixFS `File` with the size of each child. */
function branch(children: Node[]): Node {
  const fileSize = children.reduce((sum, c) => sum + c.fileSize, 0)
  const unixfs = Buffer.concat([
    varintField(1, UNIXFS_FILE),
    varintField(3, fileSize),
    ...children.map((c) => varintField(4, c.fileSize)),
  ])
  const links = children.map((c) =>
    bytesField(2, Buffer.concat([bytesField(1, c.cid), bytesField(2, new Uint8Array(0)), varintField(3, c.tsize)])),
  )
  const block = Buffer.concat([...links, bytesField(1, unixfs)])
  return { cid: cidV1(DAG_PB, block), tsize: block.length + children.reduce((s, c) => s + c.tsize, 0), fileSize }
}

/** CIDv1 (base32) of `file` as `ipfs add --cid-version=1` computes it. */
export function fileCid(file: Uint8Array): string {
  const leaves: Node[] = []
  for (let at = 0; at < file.length || at === 0; at += CHUNK_SIZE) {
    leaves.push(leaf(file.subarray(at, at + CHUNK_SIZE)))
  }
  // Balanced layout: every new level puts the current root as the first child and fills the rest left to right.
  let next = 1
  const fill = (children: Node[], depth: number): Node[] => {
    while (children.length < MAX_LINKS && next < leaves.length) {
      children.push(depth === 1 ? leaves[next++]! : branch(fill([], depth - 1)))
    }
    return children
  }
  let root = leaves[0]!
  for (let depth = 1; next < leaves.length; depth++) root = branch(fill([root], depth))
  return cidString(root.cid)
}
