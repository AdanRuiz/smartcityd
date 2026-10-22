// SDK-9: the core uses only what browsers, Node ≥ 20 and Workers have in common. The compiler sees no DOM or
// Node types (`lib: ES2022`, `types: []`), so these few globals are declared here, as narrowly as they are used.

export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

export type WebSocketConstructor = new (url: string) => WebSocketLike

export const OPEN = 1

/** The part of a `fetch` response the SDK uses. */
export interface FetchResponse {
  readonly ok: boolean
  arrayBuffer(): Promise<ArrayBuffer>
}

/** The part of the `fetch` options the SDK uses: only to upload attachments (`PUT /v1/blob`). */
export interface FetchInit {
  method: string
  headers: Record<string, string>
  body: Uint8Array
}

export type Fetch = (url: string, init?: FetchInit) => Promise<FetchResponse>

interface Globals {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  WebSocket?: WebSocketConstructor
  TextEncoder: new () => { encode(text: string): Uint8Array }
  TextDecoder: new () => { decode(bytes: Uint8Array): string }
  URL: new (url: string) => ParsedUrl
  fetch?: Fetch
  crypto: { subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> } }
  Blob: new (parts: Uint8Array[]) => { stream(): { pipeThrough(transform: unknown): unknown } }
  DecompressionStream: new (format: 'gzip') => unknown
  Response: new (body: unknown) => { arrayBuffer(): Promise<ArrayBuffer> }
  btoa(data: string): string
}

export interface ParsedUrl {
  protocol: string
  host: string
  pathname: string
  search: string
}

const g = globalThis as unknown as Globals

/** Throws on a malformed URL, like `new URL`. */
export const parseUrl = (url: string): ParsedUrl => new g.URL(url)

export const setTimer = (fn: () => void, ms: number): unknown => g.setTimeout(fn, ms)
export const clearTimer = (handle: unknown): void => g.clearTimeout(handle)
export const globalWebSocket = (): WebSocketConstructor | undefined => g.WebSocket

const encoder = new g.TextEncoder()
export const byteLength = (text: string): number => encoder.encode(text).length

export const globalFetch = (): Fetch | undefined => (g.fetch ? (url, init) => g.fetch!(url, init) : undefined)

export const decodeUtf8 = (bytes: Uint8Array): string => new g.TextDecoder().decode(bytes)

export const base64Utf8 = (text: string): string => g.btoa(Array.from(encoder.encode(text), (b) => String.fromCharCode(b)).join(''))

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await g.crypto.subtle.digest('SHA-256', data))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Rejects when the data is not gzip. */
export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new g.Blob([data]).stream().pipeThrough(new g.DecompressionStream('gzip'))
  return new Uint8Array(await new g.Response(stream).arrayBuffer())
}

export const now = (): number => Math.floor(Date.now() / 1000)

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimer(resolve, ms))
