import { createHash } from 'node:crypto'

// OpenTimestamps proofs (docs/spec/06, "Sello de tiempo"; SNAP-7). No dependency: the format is a tree of hash
// operations ending in attestations, serialized with a few tags and LEB128 lengths, as in the reference client
// (python-opentimestamps, `core/timestamp.py`, `core/op.py`, `core/notary.py`, `core/serialize.py`).

/** Magic bytes that open a detached `.ots` file, followed by the major version. */
export const HEADER_MAGIC = Uint8Array.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72,
  0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
])
const MAJOR_VERSION = 1

const PENDING_TAG = '83dfe30d2ef90c8e'
const BITCOIN_TAG = '0588960d73d71901'

// Limits of the reference client, so a calendar cannot hand back a proof other clients refuse.
const MAX_ARG_LENGTH = 4096
const MAX_PAYLOAD_LENGTH = 8192
const MAX_URI_LENGTH = 1000
const RECURSION_LIMIT = 256

const UNARY = { 0x02: 'sha1', 0x03: 'ripemd160', 0x08: 'sha256', 0x67: 'keccak256', 0xf2: 'reverse', 0xf3: 'hexlify' } as const
const BINARY = { 0xf0: 'append', 0xf1: 'prepend' } as const
type UnaryName = (typeof UNARY)[keyof typeof UNARY]
type BinaryName = (typeof BINARY)[keyof typeof BINARY]
const TAG_OF: Record<UnaryName | BinaryName, number> = {
  sha1: 0x02, ripemd160: 0x03, sha256: 0x08, keccak256: 0x67, reverse: 0xf2, hexlify: 0xf3, append: 0xf0, prepend: 0xf1,
}

export type Op = { op: UnaryName } | { op: BinaryName; arg: Uint8Array }

export type Attestation =
  | { type: 'pending'; uri: string }
  | { type: 'bitcoin'; height: number }
  | { type: 'unknown'; tag: string; payload: Uint8Array }

/** A node of the proof: what is attested about its message, and the operations that lead to further messages. */
export interface Timestamp {
  attestations: Attestation[]
  ops: [Op, Timestamp][]
}

class Writer {
  private chunks: Uint8Array[] = []
  bytes(b: Uint8Array | number[]) {
    this.chunks.push(Uint8Array.from(b))
  }
  varuint(n: number) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`ots: not a varuint: ${n}`)
    const out: number[] = []
    do {
      let byte = n % 128
      n = Math.floor(n / 128)
      if (n > 0) byte |= 0x80
      out.push(byte)
    } while (n > 0)
    this.bytes(out)
  }
  varbytes(b: Uint8Array) {
    this.varuint(b.length)
    this.bytes(b)
  }
  done(): Uint8Array {
    return Buffer.concat(this.chunks)
  }
}

class Reader {
  private pos = 0
  constructor(private readonly data: Uint8Array) {}
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.data.length) throw new Error('ots: truncated proof')
    const out = this.data.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  byte(): number {
    return this.bytes(1)[0]!
  }
  varuint(): number {
    let value = 0
    let scale = 1
    for (;;) {
      const byte = this.byte()
      value += (byte & 0x7f) * scale
      if (!Number.isSafeInteger(value)) throw new Error('ots: varuint too large')
      if ((byte & 0x80) === 0) return value
      scale *= 128
    }
  }
  varbytes(max: number, min = 0): Uint8Array {
    const length = this.varuint()
    if (length > max || length < min) throw new Error(`ots: ${length} bytes is out of range`)
    return this.bytes(length)
  }
  rest(): Uint8Array {
    return this.bytes(this.data.length - this.pos)
  }
  end() {
    if (this.pos !== this.data.length) throw new Error('ots: trailing bytes after the proof')
  }
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

function writeAttestation(w: Writer, a: Attestation) {
  const payload = new Writer()
  if (a.type === 'pending') payload.varbytes(Buffer.from(a.uri, 'utf8'))
  else if (a.type === 'bitcoin') payload.varuint(a.height)
  else payload.bytes(a.payload)
  w.bytes(Buffer.from(a.type === 'pending' ? PENDING_TAG : a.type === 'bitcoin' ? BITCOIN_TAG : a.tag, 'hex'))
  w.varbytes(payload.done())
}

function readAttestation(r: Reader): Attestation {
  const tag = hex(r.bytes(8))
  const payload = new Reader(r.varbytes(MAX_PAYLOAD_LENGTH))
  if (tag === PENDING_TAG) {
    const uri = Buffer.from(payload.varbytes(MAX_URI_LENGTH)).toString('latin1')
    // Same character set the reference client accepts, so the URI cannot smuggle anything but a URL.
    if (!/^[A-Za-z0-9.\-_/:]+$/.test(uri)) throw new Error(`ots: invalid calendar URI ${JSON.stringify(uri)}`)
    payload.end()
    return { type: 'pending', uri }
  }
  if (tag === BITCOIN_TAG) {
    const height = payload.varuint()
    payload.end()
    return { type: 'bitcoin', height }
  }
  return { type: 'unknown', tag, payload: Uint8Array.from(payload.rest()) }
}

function writeOp(w: Writer, op: Op) {
  w.bytes([TAG_OF[op.op]])
  if ('arg' in op) w.varbytes(op.arg)
}

function readOp(r: Reader, tag: number): Op {
  const unary = UNARY[tag as keyof typeof UNARY]
  if (unary) return { op: unary }
  const binary = BINARY[tag as keyof typeof BINARY]
  if (binary) return { op: binary, arg: Uint8Array.from(r.varbytes(MAX_ARG_LENGTH, 1)) }
  throw new Error(`ots: unknown operation 0x${tag.toString(16).padStart(2, '0')}`)
}

/** Every branch but the last is preceded by 0xff; an attestation branch starts with 0x00. */
function writeTimestamp(w: Writer, ts: Timestamp) {
  const branches = ts.attestations.length + ts.ops.length
  if (branches === 0) throw new Error('ots: a timestamp node needs an attestation or an operation')
  let i = 0
  for (const a of ts.attestations) {
    if (++i < branches) w.bytes([0xff])
    w.bytes([0x00])
    writeAttestation(w, a)
  }
  for (const [op, next] of ts.ops) {
    if (++i < branches) w.bytes([0xff])
    writeOp(w, op)
    writeTimestamp(w, next)
  }
}

function readTimestamp(r: Reader, depth: number): Timestamp {
  if (depth > RECURSION_LIMIT) throw new Error('ots: proof nested too deep')
  const ts: Timestamp = { attestations: [], ops: [] }
  const branch = (tag: number) => {
    if (tag === 0x00) ts.attestations.push(readAttestation(r))
    else ts.ops.push([readOp(r, tag), readTimestamp(r, depth + 1)])
  }
  let tag = r.byte()
  while (tag === 0xff) {
    branch(r.byte())
    tag = r.byte()
  }
  branch(tag)
  return ts
}

export function serializeTimestamp(ts: Timestamp): Uint8Array {
  const w = new Writer()
  writeTimestamp(w, ts)
  return w.done()
}

/** A serialized timestamp, as a calendar answers `POST /digest`; nothing may follow it. */
export function parseTimestamp(bytes: Uint8Array): Timestamp {
  const r = new Reader(bytes)
  const ts = readTimestamp(r, 0)
  r.end()
  return ts
}

/**
 * Detached `.ots` file for a 32-byte digest. The "file hash" is SHA-256, as NIP-03 uses it: the digest is the `id`
 * of the event, which is already the SHA-256 of its serialization.
 */
export function serializeDetached(digest: Uint8Array, ts: Timestamp): Uint8Array {
  if (digest.length !== 32) throw new Error('ots: a SHA-256 digest has 32 bytes')
  const w = new Writer()
  w.bytes(HEADER_MAGIC)
  w.varuint(MAJOR_VERSION)
  w.bytes([TAG_OF.sha256])
  w.bytes(digest)
  writeTimestamp(w, ts)
  return w.done()
}

export function parseDetached(bytes: Uint8Array): { digest: Uint8Array; timestamp: Timestamp } {
  const r = new Reader(bytes)
  if (hex(r.bytes(HEADER_MAGIC.length)) !== hex(HEADER_MAGIC)) throw new Error('ots: not an OpenTimestamps proof')
  const version = r.varuint()
  if (version !== MAJOR_VERSION) throw new Error(`ots: unsupported major version ${version}`)
  if (r.byte() !== TAG_OF.sha256) throw new Error('ots: only SHA-256 file digests are supported')
  const digest = Uint8Array.from(r.bytes(32))
  const timestamp = readTimestamp(r, 0)
  r.end()
  return { digest, timestamp }
}

/** The message an operation produces. Keccak-256 is not in Node's crypto and is refused. */
export function applyOp(op: Op, msg: Uint8Array): Uint8Array {
  let out: Uint8Array
  switch (op.op) {
    case 'append':
      out = Buffer.concat([msg, op.arg])
      break
    case 'prepend':
      out = Buffer.concat([op.arg, msg])
      break
    case 'sha256':
    case 'sha1':
    case 'ripemd160':
      out = createHash(op.op).update(msg).digest()
      break
    case 'reverse':
      out = Uint8Array.from(msg).reverse()
      break
    case 'hexlify':
      out = Buffer.from(hex(msg), 'utf8')
      break
    case 'keccak256':
      throw new Error('ots: keccak256 is not supported')
  }
  if (out.length > MAX_ARG_LENGTH) throw new Error('ots: operation result too long')
  return out
}

/** Each attestation of the tree with the message it attests, starting from `msg`. */
export function attestations(ts: Timestamp, msg: Uint8Array): { attestation: Attestation; msg: Uint8Array }[] {
  return [
    ...ts.attestations.map((attestation) => ({ attestation, msg })),
    ...ts.ops.flatMap(([op, next]) => attestations(next, applyOp(op, msg))),
  ]
}
