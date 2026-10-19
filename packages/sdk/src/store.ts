import { kindClass } from '@smartcity/schemas'
import type { NostrEvent } from './event.js'
import { matchesAny } from './filter.js'
import type { Filter } from './relay.js'

/** An event signed and waiting for a relay to accept it (SDK-4). */
export interface OutboxEntry {
  event: NostrEvent
  /** Seconds. */
  queuedAt: number
  attempts: number
  lastError: string | null
  /**
   * The disposable key that signed it (PRIV-5), sealed by the store, so it can be signed again if a relay finds it
   * too old (SDK-12). Kept only until a relay accepts the event.
   */
  key?: SealedKey
}

/** A secret key as the store keeps it at rest: encrypted, or in memory only. Opaque outside the store. */
export type SealedKey = { iv: Uint8Array; data: Uint8Array } | { memory: Uint8Array }

/**
 * Local store (GOAL-7, NFR-3): verified events already seen, so the app keeps showing them without relays, and the
 * outbox. Everything in it was verified before entering, and is verified again by nobody: it is this device's own.
 */
export interface Store {
  put(events: NostrEvent[]): Promise<void>
  query(filters: Filter[]): Promise<NostrEvent[]>
  /** Drops events from the local view: one this device replaced by signing it again (SDK-12). */
  forget(ids: string[]): Promise<void>
  /**
   * Seals a secret key for the outbox (ID-2: never in clear at rest). Null when this store cannot keep it safely;
   * the event is then queued without it and cannot be signed again.
   */
  sealKey(secretKey: Uint8Array): Promise<SealedKey | null>
  openKey(sealed: SealedKey): Promise<Uint8Array | null>
  outboxAdd(entry: OutboxEntry): Promise<void>
  outboxRemove(id: string): Promise<void>
  outboxList(): Promise<OutboxEntry[]>
  close(): void
}

/** How many events a local store keeps before dropping the oldest regular ones. */
export const DEFAULT_MAX_EVENTS = 20_000

/** Order of a query result: newest first, then by id (as DATA-3 breaks ties). */
export const newestFirst = (a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)

function applyLimits(filters: Filter[], events: NostrEvent[]): NostrEvent[] {
  events.sort(newestFirst)
  if (filters.some((f) => f.limit === undefined)) return events
  const max = Math.max(...filters.map((f) => f.limit!))
  return events.slice(0, max)
}

/** Store that lives as long as the client: the default outside the browser and in tests. */
export function memoryStore(maxEvents = DEFAULT_MAX_EVENTS): Store {
  const events = new Map<string, NostrEvent>()
  const outbox = new Map<string, OutboxEntry>()
  return {
    put: async (list) => {
      for (const e of list) events.set(e.id, e)
      if (events.size > maxEvents) {
        const old = [...events.values()].filter((e) => kindClass(e.kind) === 'regular').sort(newestFirst)
        for (const e of old.slice(maxEvents * 0.9)) events.delete(e.id)
      }
    },
    query: async (filters) => applyLimits(filters, [...events.values()].filter((e) => matchesAny(filters, e))),
    forget: async (ids) => ids.forEach((id) => events.delete(id)),
    // Nothing of this store reaches the disk.
    sealKey: async (secretKey) => ({ memory: secretKey.slice() }),
    openKey: async (sealed) => ('memory' in sealed ? sealed.memory.slice() : null),
    outboxAdd: async (entry) => void outbox.set(entry.event.id, entry),
    outboxRemove: async (id) => void outbox.delete(id),
    outboxList: async () => [...outbox.values()].sort((a, b) => a.queuedAt - b.queuedAt),
    close: () => {},
  }
}

// --- IndexedDB. Declared as narrowly as it is used (SDK-9: no DOM types in the core).

interface IdbRequest<T = unknown> {
  result: T
  error: unknown
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}
interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: (() => void) | null
  onblocked: (() => void) | null
}
interface IdbCursor {
  value: unknown
  primaryKey: unknown
  continue(): void
}
interface IdbIndex {
  getAll(query?: unknown): IdbRequest<unknown[]>
  openCursor(query?: unknown, direction?: string): IdbRequest<IdbCursor | null>
}
interface IdbObjectStore {
  put(value: unknown): IdbRequest
  delete(key: unknown): IdbRequest
  get(key: unknown): IdbRequest<unknown>
  getAll(): IdbRequest<unknown[]>
  count(): IdbRequest<number>
  index(name: string): IdbIndex
  createIndex(name: string, keyPath: string): void
}
interface IdbTransaction {
  objectStore(name: string): IdbObjectStore
  oncomplete: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  error: unknown
}
interface IdbDatabase {
  objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string, options: { keyPath: string }): IdbObjectStore
  transaction(names: string[], mode: 'readonly' | 'readwrite'): IdbTransaction
  close(): void
}
interface IdbFactory {
  open(name: string, version: number): IdbOpenRequest
}

export function hasIndexedDb(): boolean {
  return typeof (globalThis as { indexedDB?: unknown }).indexedDB === 'object'
}

function request<T>(req: IdbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error instanceof Error ? req.error : new Error('IndexedDB request failed'))
  })
}

function done(tx: IdbTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error instanceof Error ? tx.error : new Error('IndexedDB transaction failed'))
  })
}

const EVENTS = 'events'
const OUTBOX = 'outbox'
const KEYS = 'keys'
const SEAL_KEY_ID = 'outbox-seal'

// WebCrypto, declared as narrowly as it is used (SDK-9).
interface SubtleLike {
  generateKey(algorithm: { name: string; length: number }, extractable: boolean, usages: string[]): Promise<unknown>
  encrypt(algorithm: { name: string; iv: Uint8Array }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>
  decrypt(algorithm: { name: string; iv: Uint8Array }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>
}
interface CryptoLike {
  subtle?: SubtleLike
  getRandomValues(array: Uint8Array): Uint8Array
}
const webCrypto = (): CryptoLike | undefined => (globalThis as { crypto?: CryptoLike }).crypto

/**
 * Store in the browser's IndexedDB (SDK-4). One database per city, in the origin of the page: a different mirror or
 * `file://` has its own (APP-11). Without IndexedDB (some private windows) it falls back to memory.
 */
export async function indexedDbStore(name: string, maxEvents = DEFAULT_MAX_EVENTS): Promise<Store> {
  const factory = (globalThis as { indexedDB?: IdbFactory }).indexedDB
  if (!factory) return memoryStore(maxEvents)
  const open = factory.open(name, 2)
  open.onupgradeneeded = () => {
    const db = open.result
    if (!db.objectStoreNames.contains(EVENTS)) {
      const events = db.createObjectStore(EVENTS, { keyPath: 'id' })
      events.createIndex('kind', 'kind')
      events.createIndex('created_at', 'created_at')
    }
    if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'event.id' })
    // Version 2: the AES key that seals disposable keys waiting in the outbox (SDK-12).
    if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS, { keyPath: 'id' })
  }
  let db: IdbDatabase
  try {
    db = await request(open)
  } catch {
    return memoryStore(maxEvents)
  }
  let lastPrune = 0

  // ID-2: a disposable key at rest is encrypted with an AES-GCM `CryptoKey` that cannot be exported; IndexedDB
  // keeps the key object itself, never its bytes. Without WebCrypto (an insecure origin) nothing is sealed.
  let sealing: Promise<unknown> | null = null
  const sealingKey = (subtle: SubtleLike): Promise<unknown> =>
    (sealing ??= (async () => {
      const found = (await request(db.transaction([KEYS], 'readonly').objectStore(KEYS).get(SEAL_KEY_ID))) as
        | { key: unknown }
        | undefined
      if (found) return found.key
      const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      const tx = db.transaction([KEYS], 'readwrite')
      tx.objectStore(KEYS).put({ id: SEAL_KEY_ID, key })
      await done(tx)
      return key
    })().catch((err: unknown) => {
      sealing = null
      throw err
    }))

  const prune = async () => {
    if (Date.now() - lastPrune < 60_000) return
    lastPrune = Date.now()
    const tx = db.transaction([EVENTS], 'readwrite')
    const store = tx.objectStore(EVENTS)
    const count = await request(store.count())
    let excess = count - Math.floor(maxEvents * 0.9)
    if (count <= maxEvents) return
    // Oldest first; addressable events (definitions) are kept.
    const cursorReq = store.index('created_at').openCursor()
    await new Promise<void>((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor || excess <= 0) return resolve()
        if (kindClass((cursor.value as NostrEvent).kind) === 'regular') {
          store.delete(cursor.primaryKey)
          excess--
        }
        cursor.continue()
      }
      cursorReq.onerror = () => reject(new Error('IndexedDB cursor failed'))
    })
    await done(tx)
  }

  return {
    put: async (list) => {
      if (list.length === 0) return
      const tx = db.transaction([EVENTS], 'readwrite')
      const store = tx.objectStore(EVENTS)
      for (const e of list) store.put(e)
      await done(tx)
      await prune()
    },
    query: async (filters) => {
      const tx = db.transaction([EVENTS], 'readonly')
      const store = tx.objectStore(EVENTS)
      const found = new Map<string, NostrEvent>()
      for (const f of filters) {
        let candidates: unknown[]
        if (f.ids) candidates = await Promise.all(f.ids.map((id) => request(store.get(id))))
        else if (f.kinds) candidates = (await Promise.all(f.kinds.map((k) => request(store.index('kind').getAll(k))))).flat()
        else candidates = await request(store.getAll())
        for (const c of candidates) {
          const e = c as NostrEvent | undefined
          if (e && matchesAny([f], e)) found.set(e.id, e)
        }
      }
      return applyLimits(filters, [...found.values()])
    },
    forget: async (ids) => {
      if (ids.length === 0) return
      const tx = db.transaction([EVENTS], 'readwrite')
      for (const id of ids) tx.objectStore(EVENTS).delete(id)
      await done(tx)
    },
    sealKey: async (secretKey) => {
      const crypto = webCrypto()
      if (!crypto?.subtle) return null
      try {
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealingKey(crypto.subtle), secretKey)
        return { iv, data: new Uint8Array(data) }
      } catch {
        return null
      }
    },
    openKey: async (sealed) => {
      const subtle = webCrypto()?.subtle
      if (!subtle || !('iv' in sealed)) return null
      try {
        return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, await sealingKey(subtle), sealed.data))
      } catch {
        return null
      }
    },
    outboxAdd: async (entry) => {
      const tx = db.transaction([OUTBOX], 'readwrite')
      tx.objectStore(OUTBOX).put(entry)
      await done(tx)
    },
    outboxRemove: async (id) => {
      const tx = db.transaction([OUTBOX], 'readwrite')
      tx.objectStore(OUTBOX).delete(id)
      await done(tx)
    },
    outboxList: async () => {
      const tx = db.transaction([OUTBOX], 'readonly')
      const list = (await request(tx.objectStore(OUTBOX).getAll())) as OutboxEntry[]
      return list.sort((a, b) => a.queuedAt - b.queuedAt)
    },
    close: () => db.close(),
  }
}
