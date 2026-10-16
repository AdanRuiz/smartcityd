// Load script of phase 1 (docs/spec/09): simulated sensors publish grouped observations (DATA-9) and the
// script reports latency, size and D1 rows written per event, read from the relay's /health counters.
// Usage: node scripts/load.mjs [relay-url] [--events 200] [--sensors 20] [--readings 60] [--concurrency 10] [--http]
// --http publishes with POST /v1/events (runs in the Worker) instead of WebSocket (runs in the hub).
import { Client, key, observation, relayUrls } from './lib.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : fallback
}
const url = args.find((a) => /^(https?|wss?):/.test(a))
const total = option('events', 200)
const sensors = option('sensors', 20)
const readings = option('readings', 60)
const concurrency = option('concurrency', 10)
const viaHttp = args.includes('--http')
const { http, ws } = relayUrls(url)

const health = async () => (await fetch(`${http}/health`)).json()
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

// Each sensor stays below RATE_EVENTS_PER_MIN by publishing a total/sensors share.
const keys = Array.from({ length: sensors }, key)
const owner = key()
const events = Array.from({ length: total }, (_, i) => {
  const sensor = keys[i % sensors]
  return observation(sensor.sk, owner.pk, readings, Math.floor(Date.now() / 1000) - Math.floor(i / sensors))
})
const bytes = events.map((e) => Buffer.byteLength(JSON.stringify(e)))

console.log(`relay ${http}: ${total} events, ${sensors} sensors, ${readings} readings/event, ${concurrency} ${viaHttp ? 'parallel POSTs' : 'connections'}`)
const before = await health()
async function post(event) {
  const res = await fetch(`${http}/v1/events`, { method: 'POST', body: JSON.stringify(event) })
  const body = await res.json()
  return { ok: body.ok, message: body.ok ? (body.message ?? '') : body.reason }
}
const clients = viaHttp
  ? Array.from({ length: concurrency }, () => ({ publish: post, close() {} }))
  : await Promise.all(Array.from({ length: concurrency }, () => Client.open(ws)))
const latencies = []
const rejected = new Map()
let next = 0
const start = performance.now()
await Promise.all(
  clients.map(async (client) => {
    while (next < events.length) {
      const event = events[next++]
      const t = performance.now()
      const { ok, message } = await client.publish(event)
      latencies.push(performance.now() - t)
      if (!ok) rejected.set(message, (rejected.get(message) ?? 0) + 1)
    }
  }),
)
const elapsed = (performance.now() - start) / 1000
clients.forEach((c) => c.close())
const after = await health()

const sorted = latencies.sort((x, y) => x - y)
const stored = after.stored - before.stored
const rows = after.rowsWritten - before.rowsWritten
console.log(`
accepted        ${total - [...rejected.values()].reduce((a, b) => a + b, 0)} / ${total}  (${(total / elapsed).toFixed(1)} events/s)
OK latency      p50 ${percentile(sorted, 50).toFixed(1)} ms · p95 ${percentile(sorted, 95).toFixed(1)} ms · max ${sorted.at(-1).toFixed(1)} ms
event size      avg ${(bytes.reduce((a, b) => a + b, 0) / total / 1024).toFixed(1)} KB · ${readings} readings each
D1 rows written ${rows} for ${stored} stored events → ${stored ? (rows / stored).toFixed(1) : '–'} rows/event
                (counters of the hub: they reset if it is evicted during the run)`)
for (const [message, n] of rejected) console.log(`rejected ${n}× ${message}`)
