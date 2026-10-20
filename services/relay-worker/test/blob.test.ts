import { HTTP_AUTH_KIND } from '@smartcity/schemas'
import { describe, expect, it } from 'vitest'
import { BLOB_AUTH_WINDOW_SECONDS, BLOB_MAX_BYTES, sha256Hex, type BlobStore } from '../src/blob.js'
import { readConfig, type RelayVars } from '../src/config.js'
import { handleHttp } from '../src/http.js'
import { RateLimiter } from '../src/ratelimit.js'
import { RoleBook } from '../src/roles.js'
import { Store } from '../src/store.js'
import { NOW, key, roles, sign, sqliteDb } from './helpers.js'

// `PUT /v1/blob` / `GET /v1/blob/<sha256>` (docs/spec/07, PB-35): attachments addressed by hash, with a NIP-98
// authorization.

const ORIGIN = 'https://relay.example'
const PUT_URL = `${ORIGIN}/v1/blob`

function memoryBlobs() {
  const files = new Map<string, { data: ArrayBuffer; mime: string }>()
  const blobs: BlobStore = {
    has: async (x) => files.has(x),
    get: async (x) => {
      const file = files.get(x)
      return file ? { body: file.data, mime: file.mime, size: file.data.byteLength } : null
    },
    put: async (x, data, mime) => void files.set(x, { data, mime }),
  }
  return { files, blobs }
}

function setup(vars: RelayVars = {}, withBlobs = true) {
  const { db } = sqliteDb()
  const store = new Store(db)
  const config = readConfig(vars)
  const { files, blobs } = memoryBlobs()
  const deps = {
    store,
    config,
    limiter: new RateLimiter(() => NOW * 1000),
    now: () => NOW,
    roles: new RoleBook(config.trustAnchors),
    broadcast: () => {},
    blobs: withBlobs ? blobs : undefined,
  }
  return { files, store, http: async (request: Request) => (await handleHttp(request, deps))! }
}

const photo = (n = 1) => new Uint8Array(Array.from({ length: 1000 }, (_, i) => (i * n) % 256)).buffer

function authorization(sk: Uint8Array, payload: string, overrides: { url?: string; method?: string; createdAt?: number; kind?: number } = {}) {
  const tags = [
    ['u', overrides.url ?? PUT_URL],
    ['method', overrides.method ?? 'PUT'],
    ['payload', payload],
  ]
  const event = sign(sk, overrides.kind ?? HTTP_AUTH_KIND, tags, '', overrides.createdAt ?? NOW)
  return `Nostr ${btoa(JSON.stringify(event))}`
}

function put(body: ArrayBuffer, auth: string | null, mime = 'image/jpeg', ip = '192.0.2.1') {
  const headers: Record<string, string> = { 'Content-Type': mime, 'Content-Length': String(body.byteLength), 'CF-Connecting-IP': ip }
  if (auth !== null) headers.Authorization = auth
  return new Request(PUT_URL, { method: 'PUT', headers, body })
}

describe('attachments (docs/spec/07, /v1/blob)', () => {
  it('stores an authorized upload, and GET returns the content whose sha256 was asked', async () => {
    const r = setup()
    const { sk } = key()
    const data = photo()
    const x = await sha256Hex(data)
    const response = await r.http(put(data, authorization(sk, x)))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, x, size: 1000, mime: 'image/jpeg', url: `${PUT_URL}/${x}` })

    const got = await r.http(new Request(`${PUT_URL}/${x}`))
    expect(got.status).toBe(200)
    expect(got.headers.get('Content-Type')).toBe('image/jpeg')
    expect(got.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(got.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(got.headers.get('Cache-Control')).toContain('immutable')
    const bytes = await got.arrayBuffer()
    expect(await sha256Hex(bytes)).toBe(x)

    const head = await r.http(new Request(`${PUT_URL}/${x}`, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('Content-Length')).toBe('1000')
  })

  it('answers 404 for an unknown hash or a malformed address', async () => {
    const r = setup()
    expect((await r.http(new Request(`${PUT_URL}/${'0'.repeat(64)}`))).status).toBe(404)
    expect((await r.http(new Request(`${PUT_URL}/not-a-hash`))).status).toBe(404)
  })

  it('answers 404 when the operator did not enable attachments', async () => {
    const r = setup({}, false)
    const { sk } = key()
    const data = photo()
    const response = await r.http(put(data, authorization(sk, await sha256Hex(data))))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ ok: false, reason: expect.stringMatching(/does not store attachments/) })
  })

  it('a second upload of the same file is accepted without writing it again', async () => {
    const r = setup()
    const data = photo()
    const x = await sha256Hex(data)
    expect((await r.http(put(data, authorization(key().sk, x)))).status).toBe(200)
    expect((await r.http(put(data, authorization(key().sk, x)))).status).toBe(200)
    expect(r.files.size).toBe(1)
  })

  describe('rejections, without storing anything', () => {
    const cases: [string, (sk: Uint8Array, x: string, data: ArrayBuffer) => Request, number, RegExp][] = [
      ['no authorization', (_sk, _x, data) => put(data, null), 401, /^invalid: missing Authorization/],
      ['authorization not base64 JSON', (_sk, _x, data) => put(data, 'Nostr !!!'), 401, /^invalid: authorization is not/],
      ['another kind', (sk, x, data) => put(data, authorization(sk, x, { kind: 1 })), 401, /kind 27235/],
      ['expired authorization', (sk, x, data) => put(data, authorization(sk, x, { createdAt: NOW - BLOB_AUTH_WINDOW_SECONDS - 1 })), 401, /expired/],
      ['authorization for another URL', (sk, x, data) => put(data, authorization(sk, x, { url: 'https://other.example/v1/blob' })), 401, /another URL/],
      ['authorization for another method', (sk, x, data) => put(data, authorization(sk, x, { method: 'GET' })), 401, /another method/],
      ['body that is not the authorized one', (sk, _x, data) => put(data, authorization(sk, 'a'.repeat(64))), 400, /does not match the payload/],
      ['not an image', (sk, x, data) => put(data, authorization(sk, x), 'text/html'), 415, /Content-Type/],
    ]
    for (const [name, request, status, reason] of cases) {
      it(name, async () => {
        const r = setup()
        const data = photo()
        const response = await r.http(request(key().sk, await sha256Hex(data), data))
        expect(response.status).toBe(status)
        expect(((await response.json()) as { reason: string }).reason).toMatch(reason)
        expect(r.files.size).toBe(0)
      })
    }

    it('altered authorization signature', async () => {
      const r = setup()
      const data = photo()
      const event = JSON.parse(atob(authorization(key().sk, await sha256Hex(data)).slice(6))) as { sig: string }
      event.sig = (event.sig[0] === '0' ? '1' : '0') + event.sig.slice(1)
      const response = await r.http(put(data, `Nostr ${btoa(JSON.stringify(event))}`))
      expect(response.status).toBe(401)
      expect(((await response.json()) as { reason: string }).reason).toBe('invalid: bad authorization signature')
      expect(r.files.size).toBe(0)
    })

    it('larger than the maximum', async () => {
      const r = setup()
      const data = new Uint8Array(BLOB_MAX_BYTES + 1).buffer
      const response = await r.http(put(data, authorization(key().sk, await sha256Hex(data))))
      expect(response.status).toBe(413)
      expect(r.files.size).toBe(0)
    })

    it('over the rate limit of the key', async () => {
      const r = setup({ RATE_EVENTS_PER_MIN: '2' })
      const { sk } = key()
      const statuses: number[] = []
      for (let n = 1; n <= 3; n++) {
        const data = photo(n)
        statuses.push((await r.http(put(data, authorization(sk, await sha256Hex(data))))).status)
      }
      expect(statuses).toEqual([200, 200, 429])
    })

    it('a key without a role under WRITE_POLICY=roles', async () => {
      const anchor = key()
      const member = key()
      const r = setup({ WRITE_POLICY: 'roles', TRUST_ANCHORS: anchor.pk })
      await r.store.save(roles(anchor.sk, [[member.pk, 'source']]), NOW)
      const data = photo()
      const x = await sha256Hex(data)
      const stranger = await r.http(put(data, authorization(key().sk, x)))
      expect(stranger.status).toBe(403)
      expect(((await stranger.json()) as { reason: string }).reason).toMatch(/^restricted:/)
      expect((await r.http(put(data, authorization(member.sk, x)))).status).toBe(200)
    })
  })

  it('CORS lets the app upload from any origin', async () => {
    const r = setup()
    const response = await r.http(new Request(PUT_URL, { method: 'OPTIONS' }))
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PUT')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
  })

  it('NIP-11 announces NIP-98 and the limits only when attachments are enabled', async () => {
    const info = async (withBlobs: boolean) =>
      (await (await setup({}, withBlobs).http(new Request(`${ORIGIN}/`, { headers: { Accept: 'application/nostr+json' } }))).json()) as {
        supported_nips: number[]
        smartcity: { blobs?: { max_bytes: number } }
      }
    const on = await info(true)
    expect(on.supported_nips).toContain(98)
    expect(on.smartcity.blobs?.max_bytes).toBe(BLOB_MAX_BYTES)
    const off = await info(false)
    expect(off.supported_nips).not.toContain(98)
    expect(off.smartcity.blobs).toBeUndefined()
  })
})
