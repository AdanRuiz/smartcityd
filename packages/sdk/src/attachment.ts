import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME, HTTP_AUTH_KIND, isHex64, type Attachment } from '@smartcity/schemas'
import { base64Utf8, decodeUtf8, now, parseUrl, sha256Hex, type Fetch } from './runtime.js'
import type { Signer } from './signer.js'

// Report photos (docs/spec/03, attachments; DATA-11): uploaded to the relays' `PUT /v1/blob` (docs/spec/07) and read
// back only after checking their sha256 (SEC-4).

/** A photo to attach: a browser `File` or `Blob` fits, and so does anything with its `type` and `arrayBuffer()`. */
export interface PhotoInput {
  /** MIME type: `image/jpeg`, `image/png` or `image/webp`. */
  readonly type: string
  arrayBuffer(): Promise<ArrayBuffer>
}

/** An attachment as downloaded: bytes whose sha256 is its `x`. In the browser, show it from a `blob:` URL (SEC-4). */
export interface AttachmentData {
  data: Uint8Array
  mime: string
}

export interface AttachmentDeps {
  fetch: Fetch
  gateways: string[]
}

const isAllowedMime = (mime: string): boolean => (ATTACHMENT_MIME as readonly string[]).includes(mime)

/**
 * Uploads a photo to every given relay that stores attachments and returns the attachment for the event, with one
 * URL per relay that kept it. Its metadata is removed first (PRIV-4). Each upload carries a NIP-98 authorization
 * signed by `signer`, whose `payload` is the sha256 of the bytes. Rejects when no relay kept it.
 */
export async function uploadPhoto(photo: PhotoInput, relays: string[], signer: Signer, deps: AttachmentDeps): Promise<Attachment> {
  const mime = photo.type.split(';')[0]!.trim().toLowerCase()
  if (!isAllowedMime(mime)) throw new Error(`photos must be one of ${ATTACHMENT_MIME.join(', ')}, not ${photo.type || 'unknown'}`)
  const data = stripMetadata(new Uint8Array(await photo.arrayBuffer()), mime)
  if (data.length > ATTACHMENT_MAX_BYTES) throw new Error(`photos are at most ${ATTACHMENT_MAX_BYTES} bytes once cleaned; resize it first`)
  const x = await sha256Hex(data)

  const reasons: string[] = []
  const results = await Promise.all(
    relays.map(async (relay) => {
      const endpoint = blobEndpoint(relay)
      if (!endpoint) return null
      try {
        const auth = await signer.signEvent({
          kind: HTTP_AUTH_KIND,
          created_at: now(),
          tags: [['u', endpoint], ['method', 'PUT'], ['payload', x]],
          content: '',
        })
        const headers = { 'Content-Type': mime, Authorization: `Nostr ${base64Utf8(JSON.stringify(auth))}` }
        const res = await deps.fetch(endpoint, { method: 'PUT', headers, body: data })
        if (!res.ok) throw new Error(reasonOf(await res.arrayBuffer()) ?? 'rejected')
        return `${endpoint}/${x}`
      } catch (error) {
        reasons.push(`${relay}: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }),
  )
  const urls = results.filter((url): url is string => url !== null)
  if (urls.length === 0) throw new Error(`no relay stored the photo (${reasons.join('; ') || 'no relays'})`)
  return { x, mime, size: data.length, urls }
}

/**
 * SEC-4: the bytes of an attachment from the first of its `urls` that delivers them intact (sha256 = `x`), trying
 * each IPFS gateway for an `ipfs://` URL. Only images of the allowed types and size. Rejects when none does.
 */
export async function readAttachment(attachment: Attachment, deps: AttachmentDeps): Promise<AttachmentData> {
  const { x, mime } = attachment
  if (!isHex64(x)) throw new Error('attachment x is not a sha256')
  if (!isAllowedMime(mime)) throw new Error(`attachment type ${mime} is not an allowed image`)
  const reasons: string[] = []
  for (const url of sourcesOf(attachment, deps.gateways)) {
    try {
      const res = await deps.fetch(url)
      if (!res.ok) throw new Error('not found')
      const data = new Uint8Array(await res.arrayBuffer())
      if (data.length > ATTACHMENT_MAX_BYTES) throw new Error(`larger than ${ATTACHMENT_MAX_BYTES} bytes`)
      if ((await sha256Hex(data)) !== x) throw new Error('sha256 does not match x')
      return { data, mime }
    } catch (error) {
      reasons.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`no source delivered the attachment intact (${reasons.join('; ') || 'no usable urls'})`)
}

function sourcesOf(attachment: Attachment, gateways: string[]): string[] {
  const out: string[] = []
  for (const url of Array.isArray(attachment.urls) ? attachment.urls : []) {
    if (typeof url !== 'string') continue
    if (/^https?:\/\//i.test(url)) out.push(url)
    const ipfs = /^ipfs:\/\/(.+)$/i.exec(url)
    if (ipfs) for (const gateway of gateways) out.push(`${gateway.replace(/\/+$/, '')}/ipfs/${ipfs[1]}`)
  }
  return out
}

/** `https://host/v1/blob` for `wss://host/…` (the reference relay serves HTTP on the same host, docs/spec/07). */
export function blobEndpoint(relay: string): string | null {
  try {
    const { protocol, host } = parseUrl(relay)
    const http = protocol === 'wss:' ? 'https:' : protocol === 'ws:' ? 'http:' : null
    return http ? `${http}//${host}/v1/blob` : null
  } catch {
    return null
  }
}

function reasonOf(body: ArrayBuffer): string | null {
  try {
    const reason = (JSON.parse(decodeUtf8(new Uint8Array(body))) as { reason?: unknown }).reason
    return typeof reason === 'string' ? reason : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- PRIV-4: metadata removal

/**
 * PRIV-4: the image without its metadata (EXIF, XMP, IPTC, comments, text chunks), keeping what decoding needs
 * (colour profile included). Works on the bytes, without decoding the image, so it runs anywhere (SDK-9). Throws on a
 * file it cannot parse: better not to upload than to upload it uncleaned.
 */
export function stripMetadata(data: Uint8Array, mime: string): Uint8Array {
  if (mime === 'image/jpeg') return stripJpeg(data)
  if (mime === 'image/png') return stripPng(data)
  if (mime === 'image/webp') return stripWebp(data)
  throw new Error(`cannot clean ${mime}`)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const ascii = (data: Uint8Array, at: number, length: number): string => String.fromCharCode(...data.subarray(at, at + length))

const malformed = (format: string): Error => new Error(`not a well-formed ${format} file`)

/**
 * Keeps APP0 (JFIF), APP2 `ICC_PROFILE` and APP14 `Adobe` (colour); drops every other APPn (EXIF and XMP live in
 * APP1, IPTC in APP13) and COM. Stops at EOI: what follows (phones append previews with their own EXIF) is dropped.
 */
function stripJpeg(d: Uint8Array): Uint8Array {
  if (d[0] !== 0xff || d[1] !== 0xd8) throw malformed('JPEG')
  const parts = [d.subarray(0, 2)]
  let i = 2
  for (;;) {
    if (d[i] !== 0xff) throw malformed('JPEG')
    while (d[i + 1] === 0xff) i++ // fill bytes
    const marker = d[i + 1]
    if (marker === undefined) throw malformed('JPEG')
    if (marker === 0xd9) {
      parts.push(d.subarray(i, i + 2))
      return concat(parts)
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(d.subarray(i, i + 2))
      i += 2
      continue
    }
    if (i + 4 > d.length) throw malformed('JPEG')
    const end = i + 2 + ((d[i + 2]! << 8) | d[i + 3]!)
    if (end > d.length || end < i + 4) throw malformed('JPEG')
    let next = end
    if (marker === 0xda) {
      // Entropy-coded data up to the next marker that is not a stuffed 0xFF00 or a restart marker.
      while (next + 1 < d.length && !(d[next] === 0xff && d[next + 1] !== 0x00 && !(d[next + 1]! >= 0xd0 && d[next + 1]! <= 0xd7))) next++
      if (next + 1 >= d.length) throw malformed('JPEG')
    }
    if (!dropsJpegSegment(marker, d, i + 4)) parts.push(d.subarray(i, next))
    i = next
  }
}

function dropsJpegSegment(marker: number, d: Uint8Array, payload: number): boolean {
  if (marker === 0xfe) return true
  if (marker < 0xe1 || marker > 0xef) return false
  if (marker === 0xe2) return ascii(d, payload, 12) !== 'ICC_PROFILE\0'
  if (marker === 0xee) return ascii(d, payload, 5) !== 'Adobe'
  return true
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_METADATA = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])

/** Drops the text, EXIF and time chunks; stops at IEND. */
function stripPng(d: Uint8Array): Uint8Array {
  if (!PNG_SIGNATURE.every((b, k) => d[k] === b)) throw malformed('PNG')
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const parts = [d.subarray(0, 8)]
  let i = 8
  for (;;) {
    if (i + 12 > d.length) throw malformed('PNG')
    const end = i + 12 + view.getUint32(i)
    if (end > d.length) throw malformed('PNG')
    const type = ascii(d, i + 4, 4)
    if (!PNG_METADATA.has(type)) parts.push(d.subarray(i, end))
    if (type === 'IEND') return concat(parts)
    i = end
  }
}

/** Drops the EXIF and XMP chunks, clears their flags in VP8X and fixes the RIFF size. */
function stripWebp(d: Uint8Array): Uint8Array {
  if (d.length < 12 || ascii(d, 0, 4) !== 'RIFF' || ascii(d, 8, 4) !== 'WEBP') throw malformed('WebP')
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const riffEnd = Math.min(d.length, 8 + view.getUint32(4, true))
  const parts: Uint8Array[] = [new Uint8Array(12)]
  let i = 12
  while (i < riffEnd) {
    if (i + 8 > riffEnd) throw malformed('WebP')
    const size = view.getUint32(i + 4, true)
    const end = i + 8 + size + (size % 2)
    if (end > riffEnd + (size % 2)) throw malformed('WebP')
    const type = ascii(d, i, 4)
    if (type === 'VP8X') {
      const chunk = d.slice(i, Math.min(end, d.length))
      chunk[8] = chunk[8]! & ~0x0c // EXIF (0x08) and XMP (0x04) flags
      parts.push(chunk)
    } else if (type !== 'EXIF' && type !== 'XMP ') {
      parts.push(d.subarray(i, Math.min(end, d.length)))
    }
    i = end
  }
  const out = concat(parts)
  out.set(d.subarray(0, 12))
  new DataView(out.buffer).setUint32(4, out.length - 8, true)
  return out
}
