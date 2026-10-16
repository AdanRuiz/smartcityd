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

interface Globals {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  WebSocket?: WebSocketConstructor
  TextEncoder: new () => { encode(text: string): Uint8Array }
  URL: new (url: string) => ParsedUrl
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

export const now = (): number => Math.floor(Date.now() / 1000)

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimer(resolve, ms))
