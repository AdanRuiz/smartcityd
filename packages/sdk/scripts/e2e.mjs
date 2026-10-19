// NFR-1 de extremo a extremo: un cliente publica observaciones y otro, suscrito, las recibe.
// Uso: node scripts/e2e.mjs [wss://relay-a,wss://relay-b] [--rounds 20]
// Publica datos de prueba (dataset `sdk-e2e`, llave desechable) en los relays indicados.
import { KIND } from '@smartcity/schemas'
import Table from 'cli-table3'
import { createClient, generateSecretKey, localSigner } from '../dist/index.js'

const args = process.argv.slice(2)
const relays = (args.find((a) => !a.startsWith('--')) ?? process.env.RELAYS ?? 'ws://127.0.0.1:8787').split(',')
const rounds = Number(args[args.indexOf('--rounds') + 1] ?? 20) || 20
const city = 'mx-gdl'
const loc = [20.6668, -103.3918]

const writer = await createClient({ city, relays, signer: localSigner(generateSecretKey()) })
const reader = await createClient({ city, relays })
const pubkey = await writer.pubkey()
const dataset = `${KIND.DATASET}:${pubkey}:sdk-e2e`

const def = await writer.datasets.define({
  d: 'sdk-e2e', name: 'Prueba SDK', license: 'CC0-1.0', mode: 'observation', geometry: 'point',
  fields: { pm25: { type: 'number', unit: 'ug/m3', min: 0, max: 1000 } }, categories: ['prueba'],
})
console.log(`dataset ${def.address}: accepted by ${def.accepted.join(', ') || 'none'}`)

const sentAt = new Map()
const latencies = []
let ready
const eose = new Promise((r) => (ready = r))
const close = reader.observations.subscribe({ dataset }, (r) => {
  const t = sentAt.get(r.values.pm25)
  if (t === undefined) return
  latencies.push(performance.now() - t)
  sentAt.delete(r.values.pm25)
}, ready)
await eose

for (let i = 1; i <= rounds; i++) {
  sentAt.set(i, performance.now())
  const res = await writer.observations.publish({ dataset, loc, obs: [{ ts: Math.floor(Date.now() / 1000), values: { pm25: i } }] })
  if (res.accepted.length === 0) console.log(`round ${i}: no OK`, res.rejected)
  await new Promise((r) => setTimeout(r, 200))
}
const deadline = Date.now() + 5000
while (sentAt.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))

latencies.sort((a, b) => a - b)
const p = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]?.toFixed(0)
console.log(`received ${latencies.length}/${rounds}; publish→receive p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${p(1)} ms`)
const table = new Table({ head: ['relay', 'read', 'write', 'state', 'latency', 'last error'] })
for (const r of reader.relays.status()) {
  table.push([r.url, r.read ? 'yes' : 'no', r.write ? 'yes' : 'no', r.state, r.latencyMs === null ? '–' : `${r.latencyMs.toFixed(0)} ms`, r.lastError ?? ''])
}
console.log(table.toString())
close()
writer.close()
reader.close()
process.exit(latencies.length === rounds && Number(p(0.95)) < 3000 ? 0 : 1)
