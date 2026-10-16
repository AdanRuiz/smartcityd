// Shared helpers for the scripts that talk to a running relay (wrangler dev or a deployed one).
import { KIND } from '@smartcity/schemas'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

export const CITY = 'mx-gdl'
export const G = [
  ['g', '9ewm'],
  ['g', '9ewmq'],
  ['g', '9ewmqx'],
]

export function relayUrls(arg = process.env.RELAY_URL ?? 'http://127.0.0.1:8787') {
  const http = arg.replace(/^ws/, 'http').replace(/\/$/, '')
  return { http, ws: http.replace(/^http/, 'ws') }
}

export const now = () => Math.floor(Date.now() / 1000)

export function key() {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}

export function sign(sk, kind, tags, content, createdAt = now()) {
  return finalizeEvent({ kind, tags, content: typeof content === 'string' ? content : JSON.stringify(content), created_at: createdAt }, sk)
}

export const airDataset = (pk) => `${KIND.DATASET}:${pk}:air-quality`

/** Grouped observation (DATA-9): `readings` readings, one per minute, ending now. */
export function observation(sk, datasetOwner, readings = 1, createdAt = now()) {
  const obs = Array.from({ length: readings }, (_, i) => ({
    ts: createdAt - (readings - 1 - i) * 60,
    values: { pm25: Math.round(Math.random() * 500) / 10, temp: Math.round(200 + Math.random() * 100) / 10 },
  }))
  return sign(sk, KIND.OBSERVATION, [['c', CITY], ['a', airDataset(datasetOwner)], ...G], { v: 1, loc: [20.6668, -103.3918], obs }, createdAt)
}

export function dataset(sk, name, createdAt = now()) {
  return sign(sk, KIND.DATASET, [['d', 'air-quality'], ['c', '*'], ['t', 'ambiente']], {
    v: 1,
    name,
    license: 'CC0-1.0',
    mode: 'observation',
    geometry: 'point',
    fields: { pm25: { type: 'number', unit: 'ug/m3', min: 0, max: 1000 }, temp: { type: 'number', unit: 'Cel' } },
  }, createdAt)
}

/** Minimal NIP-01 client over the global WebSocket of Node ≥ 22. */
export class Client {
  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true })
    })
    return new Client(ws)
  }

  constructor(ws) {
    this.ws = ws
    this.waiters = []
    this.received = []
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data)
      this.received.push(msg)
      this.waiters = this.waiters.filter((w) => !(w.test(msg) && (w.resolve(msg), true)))
    })
  }

  /** Resolves with the first message matching `test`, looking from `from` in what was already received. */
  wait(test, timeoutMs = 5000, from = 0) {
    const found = this.received.slice(from).find(test)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for relay message')), timeoutMs)
      this.waiters.push({ test, resolve: (msg) => (clearTimeout(timer), resolve(msg)) })
    })
  }

  /** Sends an EVENT and resolves with the OK: [ok, message]. */
  async publish(event) {
    const from = this.received.length
    this.ws.send(JSON.stringify(['EVENT', event]))
    const [, , ok, message] = await this.wait((m) => m[0] === 'OK' && m[1] === event.id, 5000, from)
    return { ok, message }
  }

  /** REQ until EOSE; resolves with the stored events. The subscription stays open. */
  async req(subId, ...filters) {
    const from = this.received.length
    this.ws.send(JSON.stringify(['REQ', subId, ...filters]))
    const end = await this.wait((m) => (m[0] === 'EOSE' || m[0] === 'CLOSED') && m[1] === subId, 5000, from)
    if (end[0] === 'CLOSED') throw new Error(`subscription closed: ${end[2]}`)
    const index = this.received.indexOf(end)
    return this.received.slice(from, index).filter((m) => m[0] === 'EVENT' && m[1] === subId).map((m) => m[2])
  }

  close() {
    this.ws.close()
  }
}
