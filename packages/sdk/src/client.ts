import {
  ANY_CITY,
  KIND,
  MAX_FUTURE_SECONDS,
  checkValues,
  formatAddress,
  isCityId,
  isSystemKind,
  kindClass,
  parseAddress,
  tagValues,
  validateEvent,
  type CityContent,
  type DatasetContent,
  type ObservationContent,
  type SourceContent,
} from '@smartcity/schemas'
import { wins, isWellFormed, type NostrEvent, type UnsignedEvent } from './event.js'
import { MAX_CELLS, coverBBox, geoTags, inBBox, roundCoord, type BBox, type LatLon } from './geohash.js'
import { Pool, normalizeUrl, type PublishResult, type RelayFlags } from './pool.js'
import type { Filter, RelayStatus } from './relay.js'
import { clearTimer, globalWebSocket, now, setTimer, type WebSocketConstructor } from './runtime.js'
import type { Signer } from './signer.js'
import { inlineVerifier, type Verifier } from './verify.js'

export interface ClientOptions {
  /** City id (EVT-1), e.g. `mx-gdl`. */
  city: string
  /** Seed relays (REPL-5). The `relays` of the city definition are added once it is resolved (REPL-4, REPL-6). */
  relays?: string[]
  /** Without a signer the client is read-only (ID-3). */
  signer?: Signer
  /**
   * Keys trusted to define the city: the roots embedded in the build (TRUST-1). Without anchors the client does
   * not pick a city definition on its own (TRUST-3): `sc.city` stays null and `sc.cityCandidates()` lists them.
   */
  trustAnchors?: string[]
  /** Only `memory` until the local store of phase 3 (SDK-4). */
  storage?: 'memory'
  /** Event verifier. Default: on the calling thread. In the browser, pass `workerVerifier(...)` (SDK-5). */
  verifier?: Verifier
  /** WebSocket implementation, for Node 20 (`ws`) or tests. Default: the global one. */
  WebSocket?: WebSocketConstructor
  /** How long to wait for the stored events of each relay. */
  queryTimeoutMs?: number
  /** Base of the exponential backoff between publishing attempts to a relay (SDK-3). */
  retryBaseMs?: number
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
export interface Reading {
  ts: number
  values: Record<string, number | string | boolean>
  loc?: LatLon
  q: 'ok' | 'suspect' | 'bad'
  dataset: string
  source?: string
  pubkey: string
  event: string
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
}

export class ValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`event does not validate: ${errors.join('; ')}`)
    this.name = 'ValidationError'
  }
}

// Seed list when the app gives none (REPL-5): the reference relay of the project. A convenience, not a dependency.
export const SEED_RELAYS = ['wss://smartcity-relay.adan0001.workers.dev']

const MAX_SEEN = 50_000

export class Client {
  readonly cityId: string
  city: City | null = null
  readonly trustAnchors: string[]
  private readonly pool: Pool
  private readonly signer: Signer | undefined
  private readonly verifier: Verifier
  private readonly queryTimeoutMs: number
  /** Events already verified, by id. A forged copy of a known id is answered with the verified one. */
  private readonly verified = new Map<string, NostrEvent>()
  private readonly datasetCache = new Map<string, Dataset>()

  constructor(options: ClientOptions) {
    if (!isCityId(options.city)) throw new Error(`not a city id: ${options.city}`)
    const WebSocket = options.WebSocket ?? globalWebSocket()
    if (!WebSocket) throw new Error('no WebSocket implementation: pass options.WebSocket (Node 20: the `ws` package)')
    this.cityId = options.city
    this.trustAnchors = [...(options.trustAnchors ?? [])]
    this.signer = options.signer
    this.verifier = options.verifier ?? inlineVerifier
    this.queryTimeoutMs = options.queryTimeoutMs ?? 5000
    this.pool = new Pool(WebSocket, options.retryBaseMs)
    for (const url of options.relays ?? SEED_RELAYS) this.pool.add(url)
  }

  // ---------------------------------------------------------------- relays (SDK-10)

  readonly relays = {
    status: (): RelayStatus[] => this.pool.status(),
    onChange: (listener: (status: RelayStatus[]) => void): (() => void) => this.pool.onStatus(listener),
    add: (url: string, flags?: RelayFlags): void => this.pool.add(url, flags),
    remove: (url: string): void => this.pool.remove(url),
  }

  async pubkey(): Promise<string | null> {
    return this.signer ? this.signer.getPublicKey() : null
  }

  close(): void {
    this.pool.close()
    this.verifier.close?.()
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
    if (this.trustAnchors.length === 0) return null
    const events = await this.query([{ kinds: [KIND.CITY], authors: this.trustAnchors, '#d': [this.cityId] }])
    const event = events[0]
    if (!event) return this.city
    if (this.city && !wins(event, this.city.event)) return this.city
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
    if (this.verified.size >= MAX_SEEN) this.verified.delete(this.verified.keys().next().value!)
    this.verified.set(raw.id, raw)
    return raw
  }

  /**
   * Stored events matching the filters, from every read relay (REPL-2), verified and deduplicated (DATA-6).
   * Addressable events are collapsed to the winner of each address (DATA-3). Newest first.
   */
  async query(filters: Filter[]): Promise<NostrEvent[]> {
    const pending: Promise<NostrEvent | null>[] = []
    await this.pool.query(filters, (raw) => pending.push(this.check(raw)), this.queryTimeoutMs)
    const byId = new Map<string, NostrEvent>()
    for (const event of await Promise.all(pending)) if (event && matchesAny(filters, event)) byId.set(event.id, event)
    return collapse([...byId.values()]).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
  }

  /** Raw NIP-01 subscription. `onEvent` receives each verified event once. Returns the function that closes it. */
  subscribe(filters: Filter[], onEvent: (event: NostrEvent) => void, onEose?: () => void): () => void {
    const delivered = new Set<string>()
    return this.pool.subscribe(
      filters,
      (raw) => {
        void this.check(raw).then((event) => {
          if (!event || delivered.has(event.id) || !matchesAny(filters, event)) return
          delivered.add(event.id)
          onEvent(event)
        })
      },
      onEose,
    )
  }

  // ---------------------------------------------------------------- publishing (SDK-1, SDK-2, SDK-3)

  /**
   * Completes the tags (SDK-2: `c` of the client's city, the three `g` of `content.loc`), validates (SDK-1), signs
   * and sends to every write relay (SDK-3). Throws `ValidationError` without sending when it does not validate.
   */
  async publish(unsigned: UnsignedEvent): Promise<PublishResult> {
    if (!this.signer) throw new Error('read-only client: pass a signer to publish')
    const contentObject = typeof unsigned.content === 'string' ? safeParse(unsigned.content) : unsigned.content
    const tags = unsigned.tags.map((t) => [...t])
    if (isSystemKind(unsigned.kind) && unsigned.kind !== KIND.CITY && tagValues(tags, 'c').length === 0) {
      tags.push(['c', this.cityId])
    }
    const loc = (contentObject as { loc?: unknown } | null)?.loc
    if (isLatLon(loc) && tagValues(tags, 'g').length === 0) tags.push(...geoTags(loc))
    const template = {
      kind: unsigned.kind,
      created_at: unsigned.created_at ?? now(),
      tags,
      content: typeof unsigned.content === 'string' ? unsigned.content : JSON.stringify(unsigned.content),
    }
    if (isSystemKind(template.kind)) {
      const result = validateEvent(template)
      if (!result.ok) throw new ValidationError(result.errors)
    }
    const event = await this.signer.signEvent(template)
    this.verified.set(event.id, event)
    return this.pool.publish(event)
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
      return events.flatMap((e) => readings(e, q)).sort((a, b) => a.ts - b.ts)
    },

    /** New readings as they arrive (and the stored ones first). Returns the function that closes it. */
    subscribe: (q: ObservationQuery, onReading: (reading: Reading) => void, onEose?: () => void): (() => void) =>
      this.subscribe(this.observationFilters(q), (e) => readings(e, q).forEach(onReading), onEose),

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
    if (!q.bbox) return [base]
    const { cells } = coverBBox(q.bbox)
    const filters: Filter[] = []
    for (let i = 0; i < cells.length; i += MAX_CELLS) filters.push({ ...base, '#g': cells.slice(i, i + MAX_CELLS) })
    return filters
  }

  private async requirePubkey(): Promise<string> {
    const pubkey = await this.pubkey()
    if (!pubkey) throw new Error('read-only client: pass a signer to publish')
    return pubkey
  }
}

/** Creates a client and, when it has trust anchors, resolves its city definition before returning. */
export async function createClient(options: ClientOptions): Promise<Client> {
  const client = new Client(options)
  await client.resolveCity().catch(() => null)
  return client
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

/** A relay may ignore conditions it does not index; check again here. */
function matchesAny(filters: Filter[], event: NostrEvent): boolean {
  return filters.some((f) => {
    if (f.ids && !f.ids.includes(event.id)) return false
    if (f.authors && !f.authors.includes(event.pubkey)) return false
    if (f.kinds && !f.kinds.includes(event.kind)) return false
    if (f.since !== undefined && event.created_at < f.since) return false
    if (f.until !== undefined && event.created_at > f.until) return false
    for (const [key, wanted] of Object.entries(f)) {
      if (!key.startsWith('#') || !Array.isArray(wanted)) continue
      const name = key.slice(1)
      // A city carries its id in `d`; relays answer `#c` with it (docs/spec/07).
      const values = tagValues(event.tags, name === 'c' && event.kind === KIND.CITY ? 'd' : name)
      if (!values.some((v) => (wanted as string[]).includes(v))) return false
    }
    return true
  })
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

function readings(event: NostrEvent, q: ObservationQuery): Reading[] {
  if (event.kind !== KIND.OBSERVATION) return []
  const content = JSON.parse(event.content) as ObservationContent
  const a = tagValues(event.tags, 'a')
  const source = a.find((v) => v.startsWith(`${KIND.SOURCE}:`))
  if (q.source && source !== q.source) return []
  const out: Reading[] = []
  for (const o of content.obs) {
    const loc = (o.loc ?? content.loc) as LatLon | undefined
    if (q.bbox && (!loc || !inBBox(loc, q.bbox))) continue
    if (q.since !== undefined && o.ts < q.since) continue
    if (q.until !== undefined && o.ts > q.until) continue
    out.push({
      ts: o.ts,
      values: o.values,
      ...(loc ? { loc } : {}),
      q: o.q ?? 'ok',
      dataset: q.dataset,
      ...(source ? { source } : {}),
      pubkey: event.pubkey,
      event: event.id,
    })
  }
  return out
}

export { normalizeUrl }
