import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME, HTTP_AUTH_KIND, isHex64, tagValues } from '@smartcity/schemas'
import { verifyEvent } from 'nostr-tools/pure'
import { IP_RATE_FACTOR } from './config.js'
import { checkStructure, type NostrEvent } from './event.js'
import { CORS, json, type HttpDeps } from './http.js'
import { roleBookFor } from './roles.js'

// Attachments (docs/spec/07, `PUT /v1/blob` / `GET /v1/blob/<sha256>`; DATA-11): optional, addressed by the sha256 of
// their bytes. Kept apart from the Worker entry, like http.ts, so tests run it over a Map instead of R2.

/** Where the operator keeps the files: R2 in the Worker. Absent = the relay serves no attachments. */
export interface BlobStore {
  has(x: string): Promise<boolean>
  get(x: string): Promise<{ body: ReadableStream | ArrayBuffer; mime: string; size: number } | null>
  /** `x` is the sha256 of `data`, already checked. */
  put(x: string, data: ArrayBuffer, mime: string): Promise<void>
}

/** Recommended maximum of an attachment (docs/spec/03, attachments; photos are resized first, PRIV-4). */
export const BLOB_MAX_BYTES = ATTACHMENT_MAX_BYTES
/** Attachments are report photos: only images, which a browser does not run. */
export const BLOB_MIME = ATTACHMENT_MIME
/** NIP-98: how far the authorization's `created_at` may be from now. */
export const BLOB_AUTH_WINDOW_SECONDS = 60

const PATH = /^\/v1\/blob\/([0-9a-f]{64})$/

// A blob never changes for its address; nothing in it runs, even if a browser opens it directly.
const SERVE_HEADERS = {
  'Cache-Control': 'public, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
}

export function isBlobPath(pathname: string): boolean {
  return pathname === '/v1/blob' || pathname.startsWith('/v1/blob/')
}

/** Routes of `/v1/blob`. Without `deps.blobs` the operator did not enable attachments. */
export async function handleBlob(request: Request, deps: HttpDeps): Promise<Response> {
  const { blobs } = deps
  const url = new URL(request.url)
  if (!blobs) return json({ ok: false, reason: 'not found: this relay does not store attachments' }, 404)

  const match = PATH.exec(url.pathname)
  if (match && (request.method === 'GET' || request.method === 'HEAD')) {
    const blob = await blobs.get(match[1]!)
    if (!blob) return json({ ok: false, reason: 'not found' }, 404)
    const headers = { ...CORS, ...SERVE_HEADERS, 'Content-Type': blob.mime, 'Content-Length': String(blob.size) }
    return new Response(request.method === 'HEAD' ? null : blob.body, { headers })
  }
  if (url.pathname === '/v1/blob' && request.method === 'PUT') {
    const { status, ...result } = await putBlob(request, deps, blobs)
    return json(result, status)
  }
  return json({ ok: false, reason: 'not found' }, 404)
}

type PutResult =
  | { ok: true; status: 200; x: string; size: number; mime: string; url: string }
  | { ok: false; status: number; reason: string }

/**
 * Stores an attachment after checking its signed authorization (NIP-98: kind 27235 in `Authorization: Nostr <base64>`,
 * with tags `u` = this URL, `method` = PUT and `payload` = sha256 of the body). Cheap checks first; the rate limit
 * before the signature (RELAY-3) and the signature before any write (RELAY-1).
 */
async function putBlob(request: Request, deps: HttpDeps, blobs: BlobStore): Promise<PutResult> {
  const fail = (status: number, reason: string): PutResult => ({ ok: false, status, reason })
  const { config, limiter, store } = deps
  const now = deps.now()

  const length = Number(request.headers.get('Content-Length') ?? NaN)
  if (!Number.isSafeInteger(length)) return fail(411, 'invalid: Content-Length is required')
  if (length > BLOB_MAX_BYTES) return fail(413, `invalid: attachments are at most ${BLOB_MAX_BYTES} bytes`)
  if (length === 0) return fail(400, 'invalid: empty body')
  const mime = (request.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!(BLOB_MIME as readonly string[]).includes(mime)) return fail(415, `invalid: Content-Type must be one of ${BLOB_MIME.join(', ')}`)

  const auth = parseAuth(request.headers.get('Authorization'))
  if (typeof auth === 'string') return fail(401, `invalid: ${auth}`)
  if (auth.kind !== HTTP_AUTH_KIND) return fail(401, `invalid: authorization must be kind ${HTTP_AUTH_KIND}`)
  if (Math.abs(auth.created_at - now) > BLOB_AUTH_WINDOW_SECONDS) return fail(401, 'invalid: authorization expired')
  if (tagValues(auth.tags, 'u')[0] !== request.url) return fail(401, 'invalid: authorization is for another URL')
  if (tagValues(auth.tags, 'method')[0]?.toUpperCase() !== 'PUT') return fail(401, 'invalid: authorization is for another method')
  const payload = tagValues(auth.tags, 'payload')[0]
  if (!isHex64(payload)) return fail(401, 'invalid: authorization needs the sha256 of the body in a payload tag')

  // Its own windows: an upload does not use up the key's quota of events.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const max = config.rateEventsPerMin
  if (!limiter.hit([{ key: `blob-pk:${auth.pubkey}`, max }, { key: `blob-ip:${ip}`, max: max * IP_RATE_FACTOR }])) {
    return fail(429, 'rate-limited: slow down')
  }
  if (!verifyEvent(auth)) return fail(401, 'invalid: bad authorization signature')

  if (config.writePolicy === 'roles') {
    const roles = deps.roles ?? roleBookFor(config.trustAnchors)
    if (!(await roles.isAttested(auth.pubkey, null, store, now))) {
      return fail(403, 'restricted: this relay only accepts keys with a role')
    }
  }

  const data = await request.arrayBuffer()
  if (data.byteLength > BLOB_MAX_BYTES) return fail(413, `invalid: attachments are at most ${BLOB_MAX_BYTES} bytes`)
  const x = await sha256Hex(data)
  if (x !== payload) return fail(400, 'invalid: body does not match the payload hash of the authorization')

  if (!(await blobs.has(x))) await blobs.put(x, data, mime)
  return { ok: true, status: 200, x, size: data.byteLength, mime, url: new URL(`/v1/blob/${x}`, request.url).href }
}

function parseAuth(header: string | null): NostrEvent | string {
  const match = /^Nostr\s+(\S+)$/i.exec(header ?? '')
  if (!match) return 'missing Authorization: Nostr <base64 event> (NIP-98)'
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(match[1]!), (c) => c.charCodeAt(0))))
  } catch {
    return 'authorization is not a base64 JSON event'
  }
  const event = checkStructure(raw)
  return typeof event === 'string' ? `authorization: ${event}` : event
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}
