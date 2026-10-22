import {
  ANY_CITY,
  KIND,
  MAX_FUTURE_SECONDS,
  NOSTR_KIND,
  SECONDS_PER_DAY,
  checkValues,
  formatAddress,
  isCityId,
  isSystemKind,
  kindClass,
  parseAddress,
  tagValues,
  validateEvent,
  type Attachment,
  type CityContent,
  type DatasetContent,
  type ObservationContent,
  type ReportContent,
  type ReportUpdateContent,
  type Role,
  type SourceContent,
} from '@smartcity/schemas'
import {
  IPFS_GATEWAYS,
  announcedFiles,
  daysOf,
  readArchive,
  type ArchiveDeps,
  type ArchiveDiscard,
  type ArchiveQuery,
} from './archive.js'
import { readAttachment, uploadPhoto, type AttachmentData, type AttachmentDeps, type PhotoInput } from './attachment.js'
import { wins, isWellFormed, type EventTemplate, type NostrEvent, type UnsignedEvent } from './event.js'
import { matchesAny } from './filter.js'
import { MAX_CELLS, coverBBox, geoTags, inBBox, roundCoord, type BBox, type LatLon } from './geohash.js'
import { Pool, isPermanent, normalizeUrl, type PublishResult, type RelayFlags } from './pool.js'
import { getPow, inlineMiner, type CancelSignal, type Miner } from './pow.js'
import type { Filter, RelayStatus } from './relay.js'
import { clearTimer, globalFetch, globalWebSocket, now, setTimer, type Fetch, type WebSocketConstructor } from './runtime.js'
import { generateSecretKey, localSigner, type Signer } from './signer.js'
import { hasIndexedDb, indexedDbStore, memoryStore, newestFirst, type OutboxEntry, type Store } from './store.js'
import { TRUST_LEVELS, TrustState, type Signed, type TrustLevel } from './trust.js'
import { inlineVerifier, type Verifier } from './verify.js'

export interface ClientOptions {
  /** City id (EVT-1), e.g. `mx-gdl`. */
  city: string
  /** Seed relays (REPL-5). The `relays` of the city definition are added once it is resolved (REPL-4, REPL-6). */
  relays?: string[]
  /** Without a signer the client is read-only (ID-3), except for reports with a disposable key (PRIV-5). */
  signer?: Signer
  /**
   * Keys trusted to define the city and attest roles: the roots embedded in the build (TRUST-1, TRUST-4). Without
   * anchors the client does not pick a city definition on its own (TRUST-3): `sc.city` stays null and
   * `sc.cityCandidates()` lists them.
   */
  trustAnchors?: string[]
  /**
   * Local store of seen events and outbox (SDK-4, NFR-3). `indexeddb` needs `createClient` and falls back to memory
   * where there is no IndexedDB. Default `memory`.
   */
  storage?: 'memory' | 'indexeddb' | Store
  /** Event verifier. Default: on the calling thread. In the browser, pass `workerVerifier(...)` (SDK-5). */
  verifier?: Verifier
  /** Proof-of-work miner (SDK-8). Default: on the calling thread. In the browser, pass `workerMiner(...)`. */
  miner?: Miner
  /**
   * Leading zero bits to mine before signing, by kind, for keys without a role. Default: 16 for `report`, what the
   * reference relay asks by default (`POW_BITS_REPORT`). A relay that asks for more answers `pow:` and the client
   * mines again (SPAM-1).
   */
  pow?: Partial<Record<number, number>>
  /** WebSocket implementation, for Node 20 (`ws`) or tests. Default: the global one. */
  WebSocket?: WebSocketConstructor
  /** How long to wait for the stored events of each relay. */
  queryTimeoutMs?: number
  /** Base of the exponential backoff between publishing attempts to a relay (SDK-3). */
  retryBaseMs?: number
  /** How often the outbox tries again while it has events and no relay reconnected. Default 30 s. */
  outboxRetryMs?: number
  /** `fetch` for `sc.archive.read` and the attachments. Default: the global one. */
  fetch?: Fetch
  /** Gateways tried for the `cid` of a snapshot after its `urls`, and for `ipfs://` attachments. Default `IPFS_GATEWAYS`. */
  ipfsGateways?: string[]
}

export interface PublishOptions {
  /** Signs with this signer instead of the client's (a disposable key, PRIV-5). */
  signer?: Signer
  /** Cancels the proof of work (SPAM-1). */
  signal?: CancelSignal
}

export interface City {
  id: string
  content: CityContent
  event: NostrEvent
}

export interface Dataset {
  address: string
  pubkey: string
  d: string
  content: DatasetContent
  event: NostrEvent
}

export interface Source {
  address: string
  pubkey: string
  d: string
  dataset: string
  content: SourceContent
  event: NostrEvent
}

/** One reading of an observation event, flattened. */
export interface Reading extends Signed {
  ts: number
  values: Record<string, number | string | boolean>
  loc?: LatLon
  q: 'ok' | 'suspect' | 'bad'
  dataset: string
  /** Event id. */
  event: string
  /** Level when it was read; `sc.trust.levelOf(reading)` gives the current one (TRUST-7). */
  trust: TrustLevel
}

export interface DatasetInput {
  d: string
  name: string
  license: string
  mode: DatasetContent['mode']
  geometry: DatasetContent['geometry']
  fields: DatasetContent['fields']
  description?: string
  cadence_s?: number
  model?: string
  /** `t` tags. Default `['general']`. */
  categories?: string[]
  /** Default: the client's city. `'*'` for a dataset reusable across cities. */
  city?: string
}

export interface SourceInput {
  d: string
  dataset: string
  name: string
  loc?: LatLon
  elevation_m?: number
  hardware?: string
  status?: SourceContent['status']
  keys?: string[]
}

export interface ObservationInput {
  dataset: string
  source?: string
  loc?: LatLon
  obs: ObservationContent['obs']
}

export interface ObservationQuery {
  dataset: string
  bbox?: BBox
  /** Seconds. Applied to the events' `created_at` on the relays and to each reading's `ts` here. */
  since?: number
  until?: number
  source?: string
  limit?: number
  /** Only these levels. Default: all. */
  trust?: TrustLevel | TrustLevel[]
}

/** Readings of whole UTC days, from the relays and from the snapshots (`observations.history`). */
export interface HistoryQuery extends Omit<ObservationQuery, 'since' | 'until' | 'limit'> {
  /** First UTC day, `YYYY-MM-DD`. */
  from: string
  /** Last UTC day, included. Default: `from`. */
  to?: string
  /** As in `archive.read`. */
  archivers?: string[]
  onDiscard?: (discard: ArchiveDiscard) => void
}

export type ReportStatus = NonNullable<ReportUpdateContent['status']>

export interface ReportInput {
  /** `t` tag, e.g. `bache` (REPORT_CATEGORIES). */
  category: string
  title: string
  body?: string
  loc: LatLon
  /**
   * PRIV-5: `disposable` (default) signs with a new key used only for this report, so reports cannot be linked to
   * each other; `stable` signs with the client's signer.
   */
  identity?: 'disposable' | 'stable'
  /** PRIV-3: decimals kept of the location. Default 4 (~11 m). */
  precision?: number
  /** Up to 4 photos (`File`s in the browser), uploaded with the report's key; see `sc.attachments.upload`. */
  photos?: PhotoInput[]
  signal?: CancelSignal
}

export interface ReportUpdateInput {
  status?: ReportStatus
  body?: string
  /** Up to 4 photos, uploaded with the client's key; see `sc.attachments.upload`. */
  photos?: PhotoInput[]
}

export interface ReportUpdate extends Signed {
  created_at: number
  status?: ReportStatus
  body?: string
  /** Photos, as announced: read them with `sc.attachments.read` (SEC-4). */
  attachments: Attachment[]
  /** Its author has `authority` or `operator`: its status counts (docs/spec/03). Otherwise it is a comment. */
  official: boolean
  trust: TrustLevel
  event: NostrEvent
}

export interface Report extends Signed {
  created_at: number
  categories: string[]
  title: string
  body?: string
  loc: LatLon
  /** Photos, as announced: read them with `sc.attachments.read` (SEC-4). */
  attachments: Attachment[]
  /** Status of the newest official update; `open` without one. */
  status: ReportStatus
  /** The update that sets `status`, if any. */
  statusUpdate: ReportUpdate | null
  /** Every update, oldest first. */
  updates: ReportUpdate[]
  trust: TrustLevel
  event: NostrEvent
}

export interface ReportQuery {
  category?: string | string[]
  bbox?: BBox
  since?: number
  until?: number
  limit?: number
  status?: ReportStatus | ReportStatus[]
  trust?: TrustLevel | TrustLevel[]
}

export class ValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`event does not validate: ${errors.join('; ')}`)
    this.name = 'ValidationError'
  }
}

// Seed list when the app gives none (REPL-5): the project's two reference relays. A convenience, not a dependency.
export const SEED_RELAYS = ['wss://smartcity-relay.adan0001.workers.dev', 'wss://smartcity-relay-b.adan0001.workers.dev']

/** `POW_BITS_REPORT` of the reference relay (docs/spec/07). */
export const DEFAULT_POW: Partial<Record<number, number>> = { [KIND.REPORT]: 16 }

/** PRIV-3 */
export const REPORT_PRECISION = 4

/** docs/spec/03: `attachments` of a report or an update. */
export const MAX_PHOTOS = 4
const MAX_SEEN = 50_000
// The reference relay takes at most 80 values per filter (services/relay-worker, filter.ts).
const IDS_PER_FILTER = 60
const MODERATION_KINDS = [NOSTR_KIND.LABEL, NOSTR_KIND.ABUSE_REPORT]

type StorageApi = {
  /** SDK-11: whether the browser granted persistent storage; null until asked, or where it cannot be asked. */
  persisted: boolean | null
  persist(): Promise<boolean | null>
}

export class Client {
  readonly cityId: string
  city: City | null = null
  private readonly pool: Pool
  private signer: Signer | undefined
  private readonly verifier: Verifier
  private readonly miner: Miner
  private readonly powBits: Partial<Record<number, number>>
  private readonly queryTimeoutMs: number
  private readonly store: Store
  private readonly trustState: TrustState
  /** Events already verified, by id. A forged copy of a known id is answered with the verified one. */
  private readonly verified = new Map<string, NostrEvent>()
  private readonly datasetCache = new Map<string, Dataset>()
  private toRemember: NostrEvent[] = []
  private rememberTimer: unknown = null
  private readonly trustListeners = new Set<() => void>()
  private trustTimer: unknown = null
  private readonly outboxListeners = new Set<(entries: OutboxEntry[]) => void>()
  private readonly outboxRejected: { event: NostrEvent; reason: string }[] = []
  private flushing: Promise<void> | null = null
  private outboxTimer: unknown = null
  private readonly outboxRetryMs: number
  private readonly fetch: Fetch | undefined
  private readonly ipfsGateways: string[]
  private closed = false
  private readonly openRelays = new Set<string>()

  constructor(options: ClientOptions) {
    if (!isCityId(options.city)) throw new Error(`not a city id: ${options.city}`)
    if (options.storage === 'indexeddb') throw new Error("storage 'indexeddb' needs createClient()")
    const WebSocket = options.WebSocket ?? globalWebSocket()
    if (!WebSocket) throw new Error('no WebSocket implementation: pass options.WebSocket (Node 20: the `ws` package)')
    this.cityId = options.city
    this.trustState = new TrustState(options.trustAnchors ?? [], options.city)
    this.signer = options.signer
    this.verifier = options.verifier ?? inlineVerifier
    this.miner = options.miner ?? inlineMiner
    this.powBits = options.pow ?? DEFAULT_POW
    this.queryTimeoutMs = options.queryTimeoutMs ?? 5000
    this.outboxRetryMs = options.outboxRetryMs ?? 30_000
    this.fetch = options.fetch ?? globalFetch()
    this.ipfsGateways = options.ipfsGateways ?? IPFS_GATEWAYS
    this.store = typeof options.storage === 'object' ? options.storage : memoryStore()
    this.pool = new Pool(WebSocket, options.retryBaseMs)
    for (const url of options.relays ?? SEED_RELAYS) this.pool.add(url)
    // SDK-4: a relay that (re)connects is the moment to send what waits in the outbox.
    this.pool.onStatus((status) => {
      let reconnected = false
      for (const r of status) {
        if (r.state === 'open' && !this.openRelays.has(r.url)) reconnected = true
        if (r.state === 'open') this.openRelays.add(r.url)
        else this.openRelays.delete(r.url)
      }
      if (reconnected) void this.outbox.flush()
    })
  }

  /** The anchors in use (TRUST-1, TRUST-2). */
  get trustAnchors(): string[] {
    return this.trustState.getAnchors()
  }

  // ---------------------------------------------------------------- relays (SDK-10)

  readonly relays = {
    status: (): RelayStatus[] => this.pool.status(),
    onChange: (listener: (status: RelayStatus[]) => void): (() => void) => this.pool.onStatus(listener),
    add: (url: string, flags?: RelayFlags): void => this.pool.add(url, flags),
    remove: (url: string): void => this.pool.remove(url),
    /** Opens every connection now (they otherwise open on first use), to show their state. Never rejects. */
    connect: (): Promise<void> => this.pool.connect(),
  }

  /** Changes who signs (or makes the client read-only with `undefined`). */
  setSigner(signer: Signer | undefined): void {
    this.signer = signer
  }

  async pubkey(): Promise<string | null> {
    return this.signer ? this.signer.getPublicKey() : null
  }

  close(): void {
    this.closed = true
    if (this.outboxTimer !== null) clearTimer(this.outboxTimer)
    void this.flushRemembered()
    this.pool.close()
    this.verifier.close?.()
    this.miner.close?.()
  }

  // ---------------------------------------------------------------- storage (SDK-11)

  readonly storage: StorageApi = {
    persisted: null,
    persist: async () => {
      const storage = (globalThis as { navigator?: { storage?: { persist?(): Promise<boolean> } } }).navigator?.storage
      if (!storage?.persist) return null
      try {
        this.storage.persisted = await storage.persist()
      } catch {
        this.storage.persisted = false
      }
      return this.storage.persisted
    },
  }

  // ---------------------------------------------------------------- city (REPL-4, TRUST-1, TRUST-3)

  /** Every `city` definition with this client's id, signed by anyone. For the user to choose (TRUST-3). */
  async cityCandidates(): Promise<City[]> {
    const events = await this.query([{ kinds: [KIND.CITY], '#d': [this.cityId] }])
    return events.map((event) => ({ id: this.cityId, content: JSON.parse(event.content) as CityContent, event }))
  }

  /**
   * Looks up the definition signed by the trust anchors and adds its relays (REPL-4). With several, DATA-3 decides.
   * Resolves to null when there are no anchors or nothing was found; that is not an error (offline start).
   */
  async resolveCity(): Promise<City | null> {
    const anchors = this.trustAnchors
    if (anchors.length === 0) return null
    const events = await this.query([{ kinds: [KIND.CITY], authors: anchors, '#d': [this.cityId] }])
    const event = events[0]
    if (!event) return this.city
    if (this.city && anchors.includes(this.city.event.pubkey) && !wins(event, this.city.event)) return this.city
    this.city = { id: this.cityId, content: JSON.parse(event.content) as CityContent, event }
    for (const url of this.city.content.relays) {
      try {
        if (!this.pool.has(url)) this.pool.add(url)
      } catch {
        // a malformed URL in a definition does not stop the client
      }
    }
    return this.city
  }

  // ---------------------------------------------------------------- trust (docs/spec/04)

  readonly trust = {
    anchors: (): string[] => this.trustAnchors,

    /**
     * TRUST-2: changes the anchors. Lists signed by the previous ones stop counting at once (TRUST-10); the city
     * definition and the lists of the new ones are looked up again.
     */
    setAnchors: async (anchors: string[]): Promise<void> => {
      this.trustState.setAnchors(anchors)
      if (this.city && !anchors.includes(this.city.event.pubkey)) this.city = null
      this.trustChanged()
      await Promise.all([this.resolveCity().catch(() => null), this.trust.refresh()])
    },

    /** Fetches the `roles` lists of the anchors (TRUST-4) and the labels and reports of their moderators. */
    refresh: async (): Promise<void> => {
      const anchors = this.trustAnchors
      if (anchors.length === 0) return
      await this.query([{ kinds: [KIND.ROLES], authors: anchors, '#d': [this.cityId] }])
      const moderators = this.trustState.moderators()
      if (moderators.length > 0) await this.query([{ kinds: MODERATION_KINDS, authors: moderators, limit: 1000 }])
    },

    /** Keeps lists and moderation up to date while open. Returns the function that stops it. */
    watch: (): (() => void) => {
      let closeModeration: (() => void) | null = null
      let watched = ''
      const followModerators = () => {
        const moderators = this.trustState.moderators()
        const key = moderators.sort().join()
        if (key === watched) return
        watched = key
        closeModeration?.()
        closeModeration = moderators.length > 0 ? this.subscribe([{ kinds: MODERATION_KINDS, authors: moderators }], () => {}) : null
      }
      const anchors = this.trustAnchors
      const closeRoles =
        anchors.length > 0 ? this.subscribe([{ kinds: [KIND.ROLES], authors: anchors, '#d': [this.cityId] }], () => {}) : () => {}
      const stop = this.trust.onChange(followModerators)
      followModerators()
      return () => {
        stop()
        closeRoles()
        closeModeration?.()
      }
    },

    rolesOf: (pubkey: string) => this.trustState.rolesOf(pubkey),
    hasRole: (pubkey: string, ...roles: Role[]) => this.trustState.hasRole(pubkey, ...roles),
    /** Current level of an event, a reading, a report or an update (TRUST-7). */
    levelOf: (item: Signed): TrustLevel => this.trustState.levelOf(item),
    attested: () => this.trustState.attested(),

    /** Called whenever levels may have changed: new lists, labels or anchors. */
    onChange: (listener: () => void): (() => void) => {
      this.trustListeners.add(listener)
      return () => this.trustListeners.delete(listener)
    },
  }

  /** `verified`, `community` or `flagged` (docs/spec/04). Computed here, never taken from the event (TRUST-7). */
  trustOf(event: NostrEvent): TrustLevel {
    return this.trustState.levelOf(signedOf(event))
  }

  private trustChanged(): void {
    if (this.trustTimer !== null) return
    this.trustTimer = setTimer(() => {
      this.trustTimer = null
      for (const listener of this.trustListeners) listener()
    }, 0)
  }

  private learn(event: NostrEvent): void {
    if (this.trustState.learn(event)) this.trustChanged()
  }

  // ---------------------------------------------------------------- receiving (SDK-5)

  /**
   * DATA-1, DATA-4, EVT-7: returns the event if it is well formed, its `id` and `sig` verify, it is not from the
   * future and, for system kinds, it matches its schema. Null otherwise.
   */
  async check(raw: unknown): Promise<NostrEvent | null> {
    if (!isWellFormed(raw)) return null
    const known = this.verified.get(raw.id)
    if (known) return known
    if (raw.created_at > now() + MAX_FUTURE_SECONDS) return null
    if (isSystemKind(raw.kind) && !validateEvent(raw).ok) return null
    if (!(await this.verifier.verify(raw))) return null
    this.accept(raw)
    return raw
  }

  /** A verified event enters the session: cache, trust and the local store. */
  private accept(event: NostrEvent, { store = true } = {}): void {
    if (this.verified.has(event.id)) return
    if (this.verified.size >= MAX_SEEN) this.verified.delete(this.verified.keys().next().value!)
    this.verified.set(event.id, event)
    this.learn(event)
    if (store) this.remember(event)
  }

  /** Writes to the local store in batches: one transaction for many events arriving together. */
  private remember(event: NostrEvent): void {
    if (kindClass(event.kind) === 'ephemeral') return
    this.toRemember.push(event)
    this.rememberTimer ??= setTimer(() => this.flushRemembered(), 300)
  }

  private flushRemembered(): Promise<void> {
    if (this.rememberTimer !== null) clearTimer(this.rememberTimer)
    this.rememberTimer = null
    const batch = this.toRemember
    this.toRemember = []
    return batch.length > 0 ? this.store.put(batch).catch(() => {}) : Promise.resolve()
  }

  /** Drops an event of this device from its local view: one replaced by signing it again (SDK-12). */
  private async forget(id: string): Promise<void> {
    await this.flushRemembered()
    this.verified.delete(id)
    await this.store.forget([id]).catch(() => {})
  }

  /** Events this device already has (NFR-3), entered into the session as verified. */
  private async local(filters: Filter[]): Promise<NostrEvent[]> {
    try {
      await this.flushRemembered()
      const events = await this.store.query(filters)
      for (const e of events) this.accept(e, { store: false })
      return events
    } catch {
      return []
    }
  }

  /**
   * Stored events matching the filters, from every read relay (REPL-2) and the local store (NFR-3), verified and
   * deduplicated (DATA-6). Addressable events are collapsed to the winner of each address (DATA-3). Newest first.
   */
  async query(filters: Filter[]): Promise<NostrEvent[]> {
    const pending: Promise<NostrEvent | null>[] = []
    const [local] = await Promise.all([
      this.local(filters),
      this.pool.query(filters, (raw) => pending.push(this.check(raw)), this.queryTimeoutMs),
    ])
    const byId = new Map<string, NostrEvent>()
    for (const event of local) byId.set(event.id, event)
    for (const event of await Promise.all(pending)) if (event && matchesAny(filters, event)) byId.set(event.id, event)
    return collapse([...byId.values()]).sort(newestFirst)
  }

  /**
   * Raw NIP-01 subscription. `onEvent` receives each verified event once, starting with those of the local store.
   * Returns the function that closes it.
   */
  subscribe(filters: Filter[], onEvent: (event: NostrEvent) => void, onEose?: () => void): () => void {
    const delivered = new Set<string>()
    let open = true
    const deliver = (event: NostrEvent | null) => {
      if (!open || !event || delivered.has(event.id) || !matchesAny(filters, event)) return
      delivered.add(event.id)
      onEvent(event)
    }
    void this.local(filters).then((events) => events.forEach(deliver))
    const close = this.pool.subscribe(filters, (raw) => void this.check(raw).then(deliver), onEose)
    return () => {
      open = false
      close()
    }
  }

  // ---------------------------------------------------------------- publishing (SDK-1 to SDK-4, SDK-8)

  /**
   * Completes the tags (SDK-2: `c` of the client's city, the three `g` of `content.loc`), validates (SDK-1), mines
   * the proof of work its kind needs (SDK-8), signs and sends to every write relay (SDK-3). With no relay accepting
   * it and no definitive rejection, it waits in the outbox (`queued: true`, SDK-4). Throws `ValidationError`
   * without sending when it does not validate.
   */
  publish(unsigned: UnsignedEvent, options: PublishOptions = {}): Promise<PublishResult> {
    return this.publishWith(unsigned, options, null)
  }

  /** `disposableKey`: the secret behind `options.signer`, kept sealed if the event is queued (SDK-12). */
  private async publishWith(unsigned: UnsignedEvent, options: PublishOptions, disposableKey: Uint8Array | null): Promise<PublishResult> {
    const signer = options.signer ?? this.signer
    if (!signer) throw new Error('read-only client: pass a signer to publish')
    const contentObject = typeof unsigned.content === 'string' ? safeParse(unsigned.content) : unsigned.content
    const tags = unsigned.tags.map((t) => [...t])
    if (isSystemKind(unsigned.kind) && unsigned.kind !== KIND.CITY && tagValues(tags, 'c').length === 0) {
      tags.push(['c', this.cityId])
    }
    const loc = (contentObject as { loc?: unknown } | null)?.loc
    if (isLatLon(loc) && tagValues(tags, 'g').length === 0) tags.push(...geoTags(loc))
    const template: EventTemplate = {
      kind: unsigned.kind,
      created_at: unsigned.created_at ?? now(),
      tags,
      content: typeof unsigned.content === 'string' ? unsigned.content : JSON.stringify(unsigned.content),
    }
    if (isSystemKind(template.kind)) {
      const result = validateEvent(template)
      if (!result.ok) throw new ValidationError(result.errors)
    }
    const pubkey = await signer.getPublicKey()
    const bits = this.trustState.isAttested(pubkey) ? 0 : (this.powBits[template.kind] ?? 0)
    let event = await this.sign(signer, template, pubkey, bits, options.signal)
    let result = await this.pool.publish(event)
    // SPAM-1: a relay asked for more work than was done. Mine again for the highest difficulty asked.
    const asked = Math.max(0, ...result.rejected.map((r) => powAsked(r.reason)))
    if (result.accepted.length === 0 && asked > getPow(event.id)) {
      event = await this.sign(signer, template, pubkey, asked, options.signal)
      result = await this.pool.publish(event)
    }
    return this.settle(event, result, disposableKey)
  }

  /**
   * Sends an event already signed elsewhere: a root key kept offline, a device. It must verify and, for system kinds,
   * validate; otherwise throws `ValidationError` without sending. Same delivery and outbox as `publish`.
   */
  async send(raw: unknown): Promise<PublishResult> {
    const event = await this.check(raw)
    if (!event) throw new ValidationError(['the event is malformed, does not verify or does not match its schema'])
    return this.settle(event, await this.pool.publish(event))
  }

  /** SDK-4: with no relay accepting it and no definitive rejection, the event waits in the outbox. */
  private async settle(event: NostrEvent, result: PublishResult, disposableKey: Uint8Array | null = null): Promise<PublishResult> {
    if (result.accepted.length > 0 || this.rejectedForGood(result)) return result
    // SDK-12: a disposable key is kept, sealed, until a relay accepts its event, so it can be signed again.
    const key = disposableKey ? await this.store.sealKey(disposableKey).catch(() => null) : null
    const entry: OutboxEntry = { event, queuedAt: now(), attempts: 1, lastError: result.rejected[0]?.reason ?? null }
    await this.store.outboxAdd(key ? { ...entry, key } : entry)
    if (this.storage.persisted === null) void this.storage.persist()
    this.outboxChanged()
    return { ...result, queued: true }
  }

  private async sign(signer: Signer, template: EventTemplate, pubkey: string, bits: number, signal?: CancelSignal) {
    const mined = bits > 0 ? await this.miner.mine(template, pubkey, bits, signal) : template
    const event = await signer.signEvent(mined)
    // What this device publishes is part of its local view at once, sent or not (NFR-3).
    this.accept(event)
    return event
  }

  /** Every write relay rejected it with a message that will not change by sending it again. */
  private rejectedForGood(result: PublishResult): boolean {
    const writers = this.pool.writerCount()
    return writers > 0 && result.rejected.length >= writers && result.rejected.every((r) => isPermanent(r.reason))
  }

  // ---------------------------------------------------------------- outbox (SDK-4, GOAL-7)

  readonly outbox = {
    /** Signed events waiting for a relay, oldest first. */
    list: (): Promise<OutboxEntry[]> =>
      this.store
        .outboxList()
        // SEC-3: the sealed key stays inside the client.
        .then((entries) => entries.map(withoutKey))
        .catch(() => []),

    /**
     * Sends again what waits. An event leaves the outbox when a relay accepts it, or when every relay rejects it
     * for good; those are kept in `rejected`. Runs on its own when a relay connects and periodically.
     */
    flush: (): Promise<void> =>
      (this.flushing ??= this.flushOutbox().finally(() => {
        this.flushing = null
      })),

    /** Events every relay refused for good, with the reason, since the client started. */
    rejected: (): { event: NostrEvent; reason: string }[] => [...this.outboxRejected],

    onChange: (listener: (entries: OutboxEntry[]) => void): (() => void) => {
      this.outboxListeners.add(listener)
      void this.outbox.list().then(listener)
      return () => this.outboxListeners.delete(listener)
    },
  }

  private async flushOutbox(): Promise<void> {
    const entries = await this.store.outboxList().catch((): OutboxEntry[] => [])
    for (let entry of entries) {
      if (this.closed) return
      let result = await this.pool.publish(entry.event, { retry: false })
      if (result.accepted.length === 0 && result.rejected.some((r) => isTooOld(r.reason))) {
        const fresh = await this.signAgain(entry).catch(() => null)
        if (fresh) {
          // The new one is queued before the old one leaves, so a crash in between loses nothing.
          const old = entry.event.id
          entry = { ...entry, event: fresh }
          await this.store.outboxAdd(entry)
          await this.store.outboxRemove(old)
          await this.forget(old)
          result = await this.pool.publish(fresh, { retry: false })
        }
      }
      if (result.accepted.length > 0) await this.store.outboxRemove(entry.event.id)
      else if (this.rejectedForGood(result)) {
        this.outboxRejected.push({ event: entry.event, reason: result.rejected[0]!.reason })
        await this.store.outboxRemove(entry.event.id)
      } else {
        await this.store.outboxAdd({ ...entry, attempts: entry.attempts + 1, lastError: result.rejected[0]?.reason ?? null })
      }
    }
    this.outboxChanged()
  }

  /**
   * SDK-12: the same event with `created_at` of now, the proof of work it carried and the same key: the disposable
   * one kept in the entry, or the client's signer if it is the author. Null when no key can sign it. The moment of
   * the fact is not lost: it is in the content (`ts`).
   */
  private async signAgain(entry: OutboxEntry): Promise<NostrEvent | null> {
    const old = entry.event
    let signer: Signer | null = null
    if (entry.key) {
      const secret = await this.store.openKey(entry.key)
      if (secret) signer = localSigner(secret)
    } else if (this.signer && (await this.signer.getPublicKey()) === old.pubkey) signer = this.signer
    if (!signer || (await signer.getPublicKey()) !== old.pubkey) return null
    const bits = Number(old.tags.find((t) => t[0] === 'nonce')?.[2] ?? 0) || 0
    const template: EventTemplate = {
      kind: old.kind,
      // Later than before even within the same second, so the id changes.
      created_at: Math.max(now(), old.created_at + 1),
      tags: old.tags.filter((t) => t[0] !== 'nonce').map((t) => [...t]),
      content: old.content,
    }
    return this.sign(signer, template, old.pubkey, bits)
  }

  private outboxChanged(): void {
    void this.outbox.list().then((entries) => {
      for (const listener of this.outboxListeners) listener(entries)
      if (this.outboxTimer !== null) clearTimer(this.outboxTimer)
      this.outboxTimer = null
      if (entries.length === 0 || this.closed) return
      // Relays without subscriptions do not reconnect on their own: try them now and then.
      this.outboxTimer = setTimer(() => {
        this.outboxTimer = null
        void this.pool.connect().then(() => this.outbox.flush())
      }, this.outboxRetryMs)
    })
  }

  // ---------------------------------------------------------------- datasets

  readonly datasets = {
    /** Datasets of this city and the reusable ones (`c = *`). */
    list: async (): Promise<Dataset[]> => {
      const events = await this.query([{ kinds: [KIND.DATASET], '#c': [this.cityId, ANY_CITY] }])
      const list = events.map(toDataset)
      for (const ds of list) this.datasetCache.set(ds.address, ds)
      return list
    },

    /** By address (`31481:<pubkey>:<d>`). Null when no relay has it. */
    get: async (address: string, { refresh = false } = {}): Promise<Dataset | null> => {
      const cached = this.datasetCache.get(address)
      if (cached && !refresh) return cached
      const a = parseAddress(address)
      if (!a || a.kind !== KIND.DATASET) throw new Error(`not a dataset address: ${address}`)
      const [event] = await this.query([{ kinds: [KIND.DATASET], authors: [a.pubkey], '#d': [a.d] }])
      if (!event) return cached ?? null
      const ds = toDataset(event)
      this.datasetCache.set(address, ds)
      return ds
    },

    define: async (input: DatasetInput): Promise<PublishResult & { address: string }> => {
      const pubkey = await this.requirePubkey()
      const { d, categories = ['general'], city = this.cityId, ...rest } = input
      const content: DatasetContent = { v: 1, ...rest }
      const tags = [['d', d], ['c', city], ...categories.map((t) => ['t', t.toLowerCase()])]
      const result = await this.publish({ kind: KIND.DATASET, tags, content })
      return { ...result, address: formatAddress({ kind: KIND.DATASET, pubkey, d }) }
    },
  }

  // ---------------------------------------------------------------- sources

  readonly sources = {
    register: async (input: SourceInput): Promise<PublishResult & { address: string }> => {
      const pubkey = await this.requirePubkey()
      const { d, dataset, status = 'active', loc, ...rest } = input
      const content: SourceContent = { v: 1, ...rest, status, ...(loc ? { loc: roundLatLon(loc) } : {}) }
      const result = await this.publish({ kind: KIND.SOURCE, tags: [['d', d], ['a', dataset]], content })
      return { ...result, address: formatAddress({ kind: KIND.SOURCE, pubkey, d }) }
    },

    list: async ({ dataset }: { dataset: string }): Promise<Source[]> => {
      const events = await this.query([{ kinds: [KIND.SOURCE], '#c': [this.cityId], '#a': [dataset] }])
      return events.map(toSource)
    },
  }

  // ---------------------------------------------------------------- observations

  readonly observations = {
    /**
     * Publishes one observation event. Besides the schema, checks `values` against the dataset's `fields` when the
     * dataset can be fetched (EVT-8).
     */
    publish: async (input: ObservationInput): Promise<PublishResult> => {
      const dataset = await this.datasets.get(input.dataset).catch(() => null)
      if (dataset) {
        const errors = input.obs.flatMap((o) => checkValues(dataset.content.fields, o.values))
        if (errors.length > 0) throw new ValidationError(errors)
      }
      const obs = input.obs.map((o) => (o.loc ? { ...o, loc: roundLatLon(o.loc as LatLon) } : o))
      const loc = input.loc ? roundLatLon(input.loc) : undefined
      const content: ObservationContent = { v: 1, ...(loc ? { loc } : {}), obs }
      const tags = [['a', input.dataset], ...(input.source ? [['a', input.source]] : [])]
      // A moving source without a common `loc` is located by its first reading (EVT-3).
      const first = obs[0]?.loc as LatLon | undefined
      if (!loc && first && dataset?.content.geometry !== 'none') tags.push(...geoTags(first))
      return this.publish({ kind: KIND.OBSERVATION, tags, content })
    },

    /** Readings of a dataset, clipped to `bbox` and to `since`/`until` (SDK-6). Oldest first. */
    query: async (q: ObservationQuery): Promise<Reading[]> => {
      const events = await this.query(this.observationFilters(q))
      return events.flatMap((e) => this.readings(e, q)).sort((a, b) => a.ts - b.ts)
    },

    /**
     * Readings of whole UTC days beyond the relays' retention (docs/spec/06, "Consulta de historial en la app"):
     * what the relays still keep plus what `archive.read` finds in the snapshots of those days, verified there
     * (SNAP-6), once per event. Oldest first.
     */
    history: async (q: HistoryQuery): Promise<Reading[]> => {
      const { from, to, archivers, onDiscard, ...rest } = q
      const days = daysOf({ from, to })
      const window: ObservationQuery = { ...rest, since: days[0]!, until: days[days.length - 1]! + SECONDS_PER_DAY - 1 }
      const archived = this.archive.read({
        from,
        ...(to ? { to } : {}),
        kinds: [KIND.OBSERVATION],
        ...(archivers ? { archivers } : {}),
        ...(onDiscard ? { onDiscard } : {}),
      })
      const live = await this.query(this.observationFilters(window))
      const byId = new Map(live.map((e) => [e.id, e]))
      for await (const event of archived) {
        if (byId.has(event.id) || !tagValues(event.tags, 'c').includes(this.cityId)) continue
        if (tagValues(event.tags, 'a').includes(q.dataset)) byId.set(event.id, event)
      }
      return [...byId.values()].flatMap((e) => this.readings(e, window)).sort((a, b) => a.ts - b.ts)
    },

    /** New readings as they arrive (and the stored ones first). Returns the function that closes it. */
    subscribe: (q: ObservationQuery, onReading: (reading: Reading) => void, onEose?: () => void): (() => void) =>
      this.subscribe(this.observationFilters(q), (e) => this.readings(e, q).forEach(onReading), onEose),

    /**
     * SDK-7, DATA-9: collects readings and publishes them as one event when `maxItems` are in or `maxSeconds`
     * have passed since the first one.
     */
    buffer: (
      target: Omit<ObservationInput, 'obs'>,
      { maxItems = 60, maxSeconds = 300 }: { maxItems?: number; maxSeconds?: number } = {},
    ) => {
      const limit = Math.min(Math.max(1, maxItems), 500)
      let obs: ObservationContent['obs'] = []
      let timer: unknown = null
      const flush = async (): Promise<PublishResult | null> => {
        if (timer !== null) clearTimer(timer)
        timer = null
        if (obs.length === 0) return null
        const batch = obs
        obs = []
        return this.observations.publish({ ...target, obs: batch })
      }
      return {
        add: (reading: ObservationContent['obs'][number]): Promise<PublishResult | null> => {
          obs.push(reading)
          if (obs.length >= limit) return flush()
          timer ??= setTimer(() => void flush().catch(() => {}), maxSeconds * 1000)
          return Promise.resolve(null)
        },
        flush,
        get size() {
          return obs.length
        },
      }
    },
  }

  private observationFilters(q: ObservationQuery): Filter[] {
    const base: Filter = { kinds: [KIND.OBSERVATION], '#c': [this.cityId], '#a': [q.dataset] }
    if (q.since !== undefined) base.since = q.since
    if (q.until !== undefined) base.until = q.until
    if (q.limit !== undefined) base.limit = q.limit
    return withCells(base, q.bbox)
  }

  private readings(event: NostrEvent, q: ObservationQuery): Reading[] {
    if (event.kind !== KIND.OBSERVATION) return []
    const content = JSON.parse(event.content) as ObservationContent
    const signed = signedOf(event)
    if (q.source && signed.source !== q.source) return []
    const trust = this.trustState.levelOf(signed)
    if (!levelWanted(q.trust, trust)) return []
    const out: Reading[] = []
    for (const o of content.obs) {
      const loc = (o.loc ?? content.loc) as LatLon | undefined
      if (q.bbox && (!loc || !inBBox(loc, q.bbox))) continue
      if (q.since !== undefined && o.ts < q.since) continue
      if (q.until !== undefined && o.ts > q.until) continue
      out.push({
        ...signed,
        ts: o.ts,
        values: o.values,
        ...(loc ? { loc } : {}),
        q: o.q ?? 'ok',
        dataset: q.dataset,
        event: event.id,
        trust,
      })
    }
    return out
  }

  // ---------------------------------------------------------------- reports (docs/spec/03, PRIV-3, PRIV-5)

  readonly reports = {
    /**
     * Publishes a citizen report. By default with a disposable key (PRIV-5), so it needs no signer, and with its
     * location rounded to 4 decimals (PRIV-3). The proof of work of `report` is mined before signing (SPAM-1).
     */
    create: async (input: ReportInput): Promise<PublishResult & { pubkey: string }> => {
      const { category, title, body, loc, identity = 'disposable', precision = REPORT_PRECISION, photos = [], signal } = input
      const disposable = identity === 'disposable' ? generateSecretKey() : null
      const signer = disposable ? localSigner(disposable) : this.signer
      if (!signer) throw new Error('read-only client: pass a signer, or use a disposable identity')
      const attachments = await this.uploadPhotos(photos, signer)
      const content: ReportContent = { v: 1, title, ...(body ? { body } : {}), loc: roundTo(loc, precision), ...attachments }
      const template = { kind: KIND.REPORT, tags: [['t', category.toLowerCase()]], content }
      const result = await this.publishWith(template, { signer, signal }, disposable)
      return { ...result, pubkey: await signer.getPublicKey() }
    },

    /**
     * Status change or comment on a report. Anyone can post one; only those of `authority` and `operator` keys set
     * the status that readers see.
     */
    update: async (report: string | { id: string; pubkey: string }, input: ReportUpdateInput): Promise<PublishResult> => {
      const target = typeof report === 'string' ? await this.reports.get(report) : report
      if (!target) throw new Error(`report not found: ${String(report)}`)
      const { photos = [], ...fields } = input
      const attachments = await this.uploadPhotos(photos, this.signer)
      const content: ReportUpdateContent = { v: 1, ...fields, ...attachments }
      return this.publish({ kind: KIND.REPORT_UPDATE, tags: [['e', target.id], ['p', target.pubkey]], content })
    },

    /** Reports of the city with their updates and current status. Newest first. */
    query: async (q: ReportQuery = {}): Promise<Report[]> => {
      const base: Filter = { kinds: [KIND.REPORT], '#c': [this.cityId] }
      const categories = q.category === undefined ? [] : [q.category].flat()
      if (categories.length > 0) base['#t'] = categories.map((c) => c.toLowerCase())
      if (q.since !== undefined) base.since = q.since
      if (q.until !== undefined) base.until = q.until
      if (q.limit !== undefined) base.limit = q.limit
      const events = (await this.query(withCells(base, q.bbox))).filter((e) => {
        const loc = (safeParse(e.content) as { loc?: unknown } | null)?.loc
        return !q.bbox || (isLatLon(loc) && inBBox(loc, q.bbox))
      })
      const reports = await this.withUpdates(events)
      const statuses = q.status === undefined ? null : [q.status].flat()
      return reports.filter((r) => (!statuses || statuses.includes(r.status)) && levelWanted(q.trust, r.trust))
    },

    get: async (id: string): Promise<Report | null> => {
      const [event] = await this.query([{ ids: [id], kinds: [KIND.REPORT] }])
      return event ? ((await this.withUpdates([event]))[0] ?? null) : null
    },

    /**
     * Calls `onChange` (at most every 300 ms) when a report or an update of this city arrives, to query again.
     * Returns the function that stops it.
     */
    watch: (onChange: () => void): (() => void) => {
      let timer: unknown = null
      const changed = () => {
        timer ??= setTimer(() => {
          timer = null
          onChange()
        }, 300)
      }
      const close = this.subscribe([{ kinds: [KIND.REPORT, KIND.REPORT_UPDATE], '#c': [this.cityId], since: now() }], changed)
      return () => {
        if (timer !== null) clearTimer(timer)
        close()
      }
    },
  }

  private async uploadPhotos(photos: PhotoInput[], signer: Signer | undefined): Promise<{ attachments?: Attachment[] }> {
    if (photos.length === 0) return {}
    if (photos.length > MAX_PHOTOS) throw new Error(`at most ${MAX_PHOTOS} photos`)
    const attachments: Attachment[] = []
    for (const photo of photos) attachments.push(await this.attachments.upload(photo, { signer }))
    return { attachments }
  }

  // ---------------------------------------------------------------- attachments (docs/spec/03, PRIV-4, SEC-4)

  readonly attachments = {
    /**
     * Uploads a photo to every write relay that stores attachments (`PUT /v1/blob`, docs/spec/07) and returns the
     * attachment to put in an event. Its metadata (EXIF, XMP…) is removed first (PRIV-4); resizing to 1600 px is up
     * to the app, which can decode the image. Signed by `options.signer` or the client's. `reports.create` with
     * `photos` does this with the report's key.
     */
    upload: async (photo: PhotoInput, options: { signer?: Signer | undefined } = {}): Promise<Attachment> => {
      const signer = options.signer ?? this.signer
      if (!signer) throw new Error('read-only client: pass a signer to upload')
      const writers = this.pool.status().filter((r) => r.write).map((r) => r.url)
      return uploadPhoto(photo, writers, signer, this.attachmentDeps())
    },

    /**
     * SEC-4: the bytes of an attachment, from the first of its `urls` (or IPFS gateway) whose sha256 matches `x`.
     * Show them from a local `blob:` URL, never by linking the remote one.
     */
    read: (attachment: Attachment): Promise<AttachmentData> => readAttachment(attachment, this.attachmentDeps()),
  }

  private attachmentDeps(): AttachmentDeps {
    if (!this.fetch) throw new Error('no fetch implementation: pass options.fetch')
    return { fetch: this.fetch, gateways: this.ipfsGateways }
  }

  // ---------------------------------------------------------------- archive (docs/spec/06, SNAP-6)

  readonly archive = {
    /**
     * Events of the city from its snapshots, for days outside the relays' retention: finds the `snapshot` events
     * of the range on the read relays, downloads each file from its `urls` or its `cid` on an IPFS gateway and keeps
     * the first copy whose sha256 matches `file.x` and `x`, checks `id`, `sig` and schema of every line (an invalid
     * one is discarded and reported to `onDiscard`), joins the daily file and its addenda by `id` and applies their
     * deletions. Oldest first. The events do not enter the local store.
     */
    read: (query: ArchiveQuery): AsyncGenerator<NostrEvent, void, undefined> => {
      const days = daysOf(query)
      const fetch = this.fetch
      if (!fetch) throw new Error('no fetch implementation: pass options.fetch')
      const filter: Filter = { kinds: [KIND.SNAPSHOT], '#c': [this.cityId], '#t': ['daily', 'addendum', 'monthly'], since: days[0]! }
      if (query.archivers) filter.authors = query.archivers
      const deps: ArchiveDeps = {
        fetch,
        gateways: this.ipfsGateways,
        check: (raw) => this.checkArchived(raw),
        onDiscard: query.onDiscard ?? (() => {}),
      }
      return this.archiveEvents(filter, query, deps)
    },
  }

  private async *archiveEvents(filter: Filter, query: ArchiveQuery, deps: ArchiveDeps): AsyncGenerator<NostrEvent, void, undefined> {
    yield* readArchive(announcedFiles(await this.query([filter])), query, deps)
  }

  /** SDK-5 for an archived event: structure, schema of system kinds and `id` + `sig`. No date limit: it is old. */
  private async checkArchived(raw: unknown): Promise<string | null> {
    if (!isWellFormed(raw)) return 'not a well-formed event'
    if (isSystemKind(raw.kind) && !validateEvent(raw).ok) return 'does not match the schema of its kind'
    return (await this.verifier.verify(raw)) ? null : 'id or sig does not verify'
  }

  private async withUpdates(events: NostrEvent[]): Promise<Report[]> {
    const ids = events.map((e) => e.id)
    const filters: Filter[] = []
    for (let i = 0; i < ids.length; i += IDS_PER_FILTER) {
      filters.push({ kinds: [KIND.REPORT_UPDATE], '#c': [this.cityId], '#e': ids.slice(i, i + IDS_PER_FILTER) })
    }
    const updates = filters.length > 0 ? await this.query(filters) : []
    const byReport = new Map<string, NostrEvent[]>()
    for (const u of updates) {
      const id = tagValues(u.tags, 'e')[0]!
      byReport.set(id, [...(byReport.get(id) ?? []), u])
    }
    return events.map((e) => this.toReport(e, byReport.get(e.id) ?? []))
  }

  private toReport(event: NostrEvent, updateEvents: NostrEvent[]): Report {
    const content = JSON.parse(event.content) as ReportContent
    const updates = updateEvents
      .map((u): ReportUpdate => {
        const c = JSON.parse(u.content) as ReportUpdateContent
        return {
          id: u.id,
          pubkey: u.pubkey,
          created_at: u.created_at,
          ...(c.status ? { status: c.status } : {}),
          ...(c.body ? { body: c.body } : {}),
          attachments: c.attachments ?? [],
          official: this.trustState.hasRole(u.pubkey, 'authority', 'operator'),
          trust: this.trustState.levelOf(u),
          event: u,
        }
      })
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
    // docs/spec/03: the newest official update with a status sets it (ties as in DATA-3).
    let statusUpdate: ReportUpdate | null = null
    for (const u of updates) if (u.official && u.status && (!statusUpdate || wins(u.event, statusUpdate.event))) statusUpdate = u
    return {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      categories: tagValues(event.tags, 't'),
      title: content.title,
      ...(content.body ? { body: content.body } : {}),
      loc: content.loc as LatLon,
      attachments: content.attachments ?? [],
      status: statusUpdate?.status ?? 'open',
      statusUpdate,
      updates,
      trust: this.trustState.levelOf(event),
      event,
    }
  }

  private async requirePubkey(): Promise<string> {
    const pubkey = await this.pubkey()
    if (!pubkey) throw new Error('read-only client: pass a signer to publish')
    return pubkey
  }
}

/**
 * Creates a client, opens its local store and, when it has trust anchors, resolves its city definition and roles
 * before returning. Then sends whatever the outbox kept from a previous session.
 */
export async function createClient(options: ClientOptions): Promise<Client> {
  let storage = options.storage
  if (storage === 'indexeddb') storage = hasIndexedDb() ? await indexedDbStore(`smartcity-${options.city}`) : 'memory'
  const client = new Client({ ...options, storage })
  await Promise.all([client.resolveCity().catch(() => null), client.trust.refresh().catch(() => {})])
  void client.outbox.flush()
  return client
}

function withoutKey(entry: OutboxEntry): OutboxEntry {
  const copy = { ...entry }
  delete copy.key
  return copy
}

/** RELAY-5: the relay refuses regular events older than its limit (`invalid: too old`, docs/spec/07 step 3). */
function isTooOld(reason: string): boolean {
  return reason.startsWith('invalid: too old')
}

/** Leading zero bits a `pow:` rejection asks for; 0 when it is not one or says no number. */
function powAsked(reason: string): number {
  if (!reason.startsWith('pow:')) return 0
  const n = /(\d+)/.exec(reason)
  return n ? Number(n[1]) : 0
}

function levelWanted(wanted: TrustLevel | TrustLevel[] | undefined, level: TrustLevel): boolean {
  return wanted === undefined || [wanted].flat().includes(level)
}

/** Splits a bbox into filters of at most MAX_CELLS geohash cells (SDK-6). */
function withCells(base: Filter, bbox: BBox | undefined): Filter[] {
  if (!bbox) return [base]
  const { cells } = coverBBox(bbox)
  const filters: Filter[] = []
  for (let i = 0; i < cells.length; i += MAX_CELLS) filters.push({ ...base, '#g': cells.slice(i, i + MAX_CELLS) })
  return filters
}

function signedOf(event: NostrEvent): Signed {
  const source = tagValues(event.tags, 'a').find((v) => v.startsWith(`${KIND.SOURCE}:`))
  return { id: event.id, pubkey: event.pubkey, ...(source ? { source } : {}) }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isLatLon(value: unknown): value is LatLon {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number')
}

function roundLatLon([lat, lon]: LatLon): LatLon {
  return [roundCoord(lat), roundCoord(lon)]
}

function roundTo([lat, lon]: LatLon, decimals: number): LatLon {
  const f = 10 ** Math.min(Math.max(0, Math.floor(decimals)), 6)
  return [Math.round(lat * f) / f, Math.round(lon * f) / f]
}

function addressKey(event: NostrEvent): string | null {
  if (kindClass(event.kind) !== 'addressable') return null
  return `${event.kind}:${event.pubkey}:${tagValues(event.tags, 'd')[0] ?? ''}`
}

/** DATA-3 over a list: keeps one event per address. */
function collapse(events: NostrEvent[]): NostrEvent[] {
  const winners = new Map<string, NostrEvent>()
  const out: NostrEvent[] = []
  for (const event of events) {
    const key = addressKey(event)
    if (key === null) out.push(event)
    else {
      const current = winners.get(key)
      if (!current || wins(event, current)) winners.set(key, event)
    }
  }
  return [...out, ...winners.values()]
}

function toDataset(event: NostrEvent): Dataset {
  const d = tagValues(event.tags, 'd')[0] ?? ''
  return {
    address: formatAddress({ kind: KIND.DATASET, pubkey: event.pubkey, d }),
    pubkey: event.pubkey,
    d,
    content: JSON.parse(event.content) as DatasetContent,
    event,
  }
}

function toSource(event: NostrEvent): Source {
  const d = tagValues(event.tags, 'd')[0] ?? ''
  return {
    address: formatAddress({ kind: KIND.SOURCE, pubkey: event.pubkey, d }),
    pubkey: event.pubkey,
    d,
    dataset: tagValues(event.tags, 'a').find((a) => a.startsWith(`${KIND.DATASET}:`)) ?? '',
    content: JSON.parse(event.content) as SourceContent,
    event,
  }
}

export { normalizeUrl, TRUST_LEVELS }
