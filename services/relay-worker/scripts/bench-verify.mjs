// CPU cost of acceptance step 5 (id + Schnorr signature, nostr-tools over @noble/curves: ADR-14 option 1)
// on this machine. A local reference only: the real figure is measured on Workers (see README).
// Usage: node scripts/bench-verify.mjs [--readings 60] [--n 300]
import Table from 'cli-table3'
import { verifyEvent } from 'nostr-tools/pure'
import { key, observation } from './lib.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : fallback
}
const n = option('n', 300)
const { sk, pk } = key()
const table = new Table({ head: ['readings', 'event size', 'ms / verification'], colAligns: ['right', 'right', 'right'] })

for (const readings of [1, option('readings', 60), 500]) {
  // Plain copies, as they arrive from the network: finalizeEvent marks its result as verified and
  // verifyEvent would answer from that cache.
  const events = Array.from({ length: n + 20 }, () => JSON.parse(JSON.stringify(observation(sk, pk, readings))))
  for (const e of events.slice(0, 20)) verifyEvent(e) // warm-up
  const start = performance.now()
  for (const e of events.slice(20)) if (!verifyEvent(e)) throw new Error('verification failed')
  const ms = (performance.now() - start) / n
  const kb = Buffer.byteLength(JSON.stringify(events[0])) / 1024
  table.push([readings, `${kb.toFixed(1)} KB`, ms.toFixed(2)])
}
console.log(table.toString())
