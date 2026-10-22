import { createHash } from 'node:crypto'
import { HTTP_AUTH_KIND, KIND, tagValues } from '@smartcity/schemas'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { Client, localSigner, stripMetadata, type Fetch, type FetchInit, type NostrEvent } from '../src/index.js'
import { fakeNetwork } from './fake-relay.js'

const CITY = 'mx-gdl'
const A = 'wss://a.example'
const B = 'wss://b.example'
const SPOT: [number, number] = [20.67654, -103.34789]

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0)) : p)))
const has = (data: Uint8Array, text: string) => Buffer.from(data).includes(text)
const photo = (data: Uint8Array, type = 'image/jpeg') => ({ type, arrayBuffer: async () => data.slice().buffer })

// ---------------------------------------------------------------- tiny images with metadata

const u16 = (n: number) => [n >> 8, n & 0xff]
const segment = (marker: number, payload: Uint8Array) => bytes([0xff, marker, ...u16(payload.length + 2)], Array.from(payload))
const JFIF = segment(0xe0, bytes('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]))
const EXIF = segment(0xe1, bytes('Exif\0\0', 'GPS 20.676 -103.347 iPhone'))
const XMP = segment(0xe1, bytes('http://ns.adobe.com/xap/1.0/\0', '<x:xmpmeta>Author</x:xmpmeta>'))
const ICC = segment(0xe2, bytes('ICC_PROFILE\0', [1, 1], 'sRGB'))
const COMMENT = segment(0xfe, bytes('taken by Juana'))
const DQT = segment(0xdb, bytes([0], Array(64).fill(1)))
// A scan with a stuffed 0xFF00 and a restart marker inside, then EOI and a phone's appended preview with EXIF.
const SCAN = bytes(Array.from(segment(0xda, bytes([1, 1, 0, 0, 0x3f, 0]))), [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])
const EOI = bytes([0xff, 0xd9])
const jpeg = (...parts: Uint8Array[]) => bytes([0xff, 0xd8], ...parts.map((p) => Array.from(p)))

function png(...chunks: [string, string][]): Uint8Array {
  const parts = [bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  for (const [type, data] of [['IHDR', 'xxxxxxxxxxxxx'], ...chunks, ['IEND', '']] as [string, string][]) {
    parts.push(bytes(le32(data.length).reverse(), type), Buffer.from(data, 'latin1'), bytes([0, 0, 0, 0]))
  }
  return new Uint8Array(Buffer.concat(parts))
}

const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
const riffChunk = (type: string, data: number[]) => [...bytes(type), ...le32(data.length), ...data, ...(data.length % 2 ? [0] : [])]
function webp(...chunks: number[][]): Uint8Array {
  const body = [...bytes('WEBP'), ...chunks.flat()]
  return new Uint8Array([...bytes('RIFF'), ...le32(body.length), ...body])
}

describe('stripMetadata (PRIV-4)', () => {
  it('drops EXIF, XMP, comments and what follows EOI from a JPEG; keeps JFIF, ICC and the image', () => {
    const clean = jpeg(JFIF, DQT, ICC, SCAN, EOI)
    const dirty = jpeg(JFIF, EXIF, XMP, ICC, COMMENT, DQT, SCAN, EOI, jpeg(EXIF, EOI))
    const out = stripMetadata(dirty, 'image/jpeg')
    expect(has(out, 'Exif')).toBe(false)
    expect(has(out, 'xmpmeta')).toBe(false)
    expect(has(out, 'Juana')).toBe(false)
    expect(Array.from(out)).toEqual(Array.from(jpeg(JFIF, ICC, DQT, SCAN, EOI)))
    expect(Array.from(stripMetadata(clean, 'image/jpeg'))).toEqual(Array.from(clean))
  })

  it('drops text, EXIF and time chunks from a PNG', () => {
    const out = stripMetadata(png(['tEXt', 'Author\0Juana'], ['eXIf', 'GPS'], ['tIME', '1234567'], ['IDAT', 'pixels']), 'image/png')
    expect(Array.from(out)).toEqual(Array.from(png(['IDAT', 'pixels'])))
  })

  it('drops EXIF and XMP chunks from a WebP and clears their flags', () => {
    const vp8x = (flags: number) => riffChunk('VP8X', [flags, 0, 0, 0, 1, 0, 0, 1, 0, 0])
    const image = riffChunk('VP8L', [1, 2, 3])
    const out = stripMetadata(webp(vp8x(0x2c), image, riffChunk('EXIF', [...bytes('GPS 20.6')]), riffChunk('XMP ', [...bytes('Juana')])), 'image/webp')
    expect(Array.from(out)).toEqual(Array.from(webp(vp8x(0x20), image)))
  })

  it('refuses what it cannot parse instead of passing it through', () => {
    expect(() => stripMetadata(bytes('GIF89a'), 'image/jpeg')).toThrow(/JPEG/)
    expect(() => stripMetadata(jpeg(JFIF, bytes([0xff, 0xe1, 0x40, 0])), 'image/jpeg')).toThrow(/JPEG/)
    expect(() => stripMetadata(png().subarray(0, 20), 'image/png')).toThrow(/PNG/)
    expect(() => stripMetadata(bytes('RIFF'), 'image/webp')).toThrow(/WebP/)
  })
})

// ---------------------------------------------------------------- upload and read

interface Stored {
  data: Uint8Array
  mime: string
  auth: NostrEvent
}

/** Relays' `/v1/blob`, as the reference relay answers it, plus other URLs served as given. */
function blobServer(hosts: string[], served: Record<string, Uint8Array> = {}) {
  const blobs = new Map<string, Stored>()
  const requests: string[] = []
  const fetch: Fetch = async (url: string, init?: FetchInit) => {
    requests.push(`${init?.method ?? 'GET'} ${url}`)
    const reply = (ok: boolean, body: unknown = {}) => ({
      ok,
      arrayBuffer: async () => (body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body))).slice().buffer,
    })
    const { host, pathname } = new URL(url)
    if (init?.method === 'PUT') {
      if (!hosts.includes(host) || pathname !== '/v1/blob') return reply(false, { ok: false, reason: 'not found' })
      const auth = JSON.parse(Buffer.from(init.headers.Authorization!.replace(/^Nostr /, ''), 'base64').toString('utf8')) as NostrEvent
      const x = sha256(init.body)
      const valid =
        verifyEvent(auth) &&
        auth.kind === HTTP_AUTH_KIND &&
        tagValues(auth.tags, 'u')[0] === url &&
        tagValues(auth.tags, 'method')[0] === 'PUT' &&
        tagValues(auth.tags, 'payload')[0] === x
      if (!valid) return reply(false, { ok: false, reason: 'invalid: bad authorization' })
      blobs.set(`${host}/${x}`, { data: init.body.slice(), mime: init.headers['Content-Type']!, auth })
      return reply(true, { ok: true, x })
    }
    const blob = blobs.get(`${host}/${pathname.replace('/v1/blob/', '')}`)
    if (blob) return reply(true, blob.data)
    return served[url] ? reply(true, served[url]) : reply(false)
  }
  return { fetch, blobs, requests }
}

function setup(relays: string[], server: ReturnType<typeof blobServer>, extra: { signer?: ReturnType<typeof localSigner> } = {}) {
  const net = fakeNetwork(...relays)
  const sc = new Client({ city: CITY, relays, WebSocket: net.WebSocket, queryTimeoutMs: 300, pow: {}, fetch: server.fetch, ...extra })
  return { net, sc }
}

const IMAGE = jpeg(JFIF, EXIF, DQT, SCAN, EOI)
const CLEAN = stripMetadata(IMAGE, 'image/jpeg')

describe('sc.attachments.upload', () => {
  it('uploads the cleaned photo to every relay that stores attachments, signed with NIP-98', async () => {
    const server = blobServer(['a.example'])
    const key = generateSecretKey()
    const { sc } = setup([A, B], server, { signer: localSigner(key) })
    const attachment = await sc.attachments.upload(photo(IMAGE))
    const x = sha256(CLEAN)
    expect(attachment).toEqual({ x, mime: 'image/jpeg', size: CLEAN.length, urls: [`https://a.example/v1/blob/${x}`] })
    const stored = server.blobs.get(`a.example/${x}`)!
    expect(has(stored.data, 'Exif')).toBe(false)
    expect(stored.auth.pubkey).toBe(getPublicKey(key))
    expect(server.requests).toContain('PUT https://b.example/v1/blob')
  })

  it('rejects when no relay keeps it, and what is not an allowed image or too large', async () => {
    const { sc } = setup([A], blobServer([]), { signer: localSigner(generateSecretKey()) })
    await expect(sc.attachments.upload(photo(IMAGE))).rejects.toThrow(/no relay stored the photo.*not found/)
    await expect(sc.attachments.upload(photo(bytes('<svg/>'), 'image/svg+xml'))).rejects.toThrow(/image\/jpeg/)
    const big = png(['IDAT', 'x'.repeat(2 * 1024 * 1024)])
    await expect(sc.attachments.upload(photo(big, 'image/png'))).rejects.toThrow(/at most/)
  })

  it('needs a signer', async () => {
    const { sc } = setup([A], blobServer(['a.example']))
    await expect(sc.attachments.upload(photo(IMAGE))).rejects.toThrow(/signer/)
  })
})

describe('sc.reports with photos', () => {
  it('uploads the photos with the disposable key of the report and announces them in its content', async () => {
    const server = blobServer(['a.example'])
    const { net, sc } = setup([A], server)
    const res = await sc.reports.create({ category: 'bache', title: 'Bache', loc: SPOT, photos: [photo(IMAGE)] })
    const x = sha256(CLEAN)
    expect(server.blobs.get(`a.example/${x}`)!.auth.pubkey).toBe(res.pubkey)
    const sent = net.relay(A).events.find((e) => e.kind === KIND.REPORT)!
    expect(JSON.parse(sent.content).attachments).toEqual([{ x, mime: 'image/jpeg', size: CLEAN.length, urls: [`https://a.example/v1/blob/${x}`] }])

    const report = (await sc.reports.get(res.id))!
    expect(report.attachments).toHaveLength(1)
    const read = await sc.attachments.read(report.attachments[0]!)
    expect(Array.from(read.data)).toEqual(Array.from(CLEAN))
    expect(read.mime).toBe('image/jpeg')
  })

  it('attaches photos to an update', async () => {
    const server = blobServer(['a.example'])
    const { net, sc } = setup([A], server, { signer: localSigner(generateSecretKey()) })
    const created = await sc.reports.create({ category: 'bache', title: 'Bache', loc: SPOT })
    await sc.reports.update(created.id, { status: 'resolved', photos: [photo(IMAGE)] })
    const update = net.relay(A).events.find((e) => e.kind === KIND.REPORT_UPDATE)!
    expect(JSON.parse(update.content)).toMatchObject({ v: 1, status: 'resolved', attachments: [{ x: sha256(CLEAN) }] })
    expect((await sc.reports.get(created.id))!.updates[0]!.attachments).toHaveLength(1)
  })

  it('refuses more than 4 photos before uploading any', async () => {
    const server = blobServer(['a.example'])
    const { sc } = setup([A], server)
    const photos = Array.from({ length: 5 }, () => photo(IMAGE))
    await expect(sc.reports.create({ category: 'bache', title: 'Bache', loc: SPOT, photos })).rejects.toThrow(/at most 4/)
    expect(server.requests).toEqual([])
  })
})

describe('sc.attachments.read (SEC-4)', () => {
  const x = sha256(CLEAN)
  const attachment = (urls: string[], mime = 'image/jpeg') => ({ x, mime, size: CLEAN.length, urls })

  it('skips sources whose bytes do not match x and returns the first intact one', async () => {
    const tampered = CLEAN.slice()
    tampered.set([tampered.at(-3)! ^ 1], tampered.length - 3)
    const server = blobServer([], { 'https://evil.example/p.jpg': tampered, 'https://ok.example/p.jpg': CLEAN })
    const { sc } = setup([A], server)
    const read = await sc.attachments.read(attachment(['https://evil.example/p.jpg', 'https://ok.example/p.jpg']))
    expect(Array.from(read.data)).toEqual(Array.from(CLEAN))
  })

  it('tries the IPFS gateways for an ipfs:// URL', async () => {
    const server = blobServer([], { 'https://gw.example/ipfs/bafyphoto': CLEAN })
    const net = fakeNetwork(A)
    const sc = new Client({ city: CITY, relays: [A], WebSocket: net.WebSocket, fetch: server.fetch, ipfsGateways: ['https://down.example/', 'https://gw.example'] })
    const read = await sc.attachments.read(attachment(['ipfs://bafyphoto']))
    expect(Array.from(read.data)).toEqual(Array.from(CLEAN))
    expect(server.requests).toEqual(['GET https://down.example/ipfs/bafyphoto', 'GET https://gw.example/ipfs/bafyphoto'])
  })

  it('rejects when no source is intact, and types that are not allowed images without downloading', async () => {
    const server = blobServer([], { 'https://evil.example/p.jpg': bytes('<html>') })
    const { sc } = setup([A], server)
    await expect(sc.attachments.read(attachment(['https://evil.example/p.jpg', 'javascript:alert(1)']))).rejects.toThrow(
      /sha256 does not match/,
    )
    await expect(sc.attachments.read(attachment(['https://evil.example/p.jpg'], 'text/html'))).rejects.toThrow(/not an allowed image/)
    expect(server.requests).toEqual(['GET https://evil.example/p.jpg'])
  })
})
