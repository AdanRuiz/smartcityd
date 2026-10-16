// Sensor simulado (fase 2, `09`): publica una lectura de calidad del aire cada N segundos y dice a qué hora la envió,
// para medir cuánto tarda en aparecer en el mapa de otra máquina (NFR-1).
// Uso: node scripts/sensor.mjs <dirección del dataset> [wss://relay-a,wss://relay-b] [--every 10] [--count 0]
//      [--loc 20.6668,-103.3918] [--key <hex de la llave>]
// Sin --key genera una llave desechable. --count 0 publica hasta Ctrl+C.
import { KIND } from '@smartcity/schemas'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { createClient, generateSecretKey, localSigner } from '../dist/index.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const dataset = positional[0]
if (!dataset?.startsWith(`${KIND.DATASET}:`)) {
  console.error('usage: node scripts/sensor.mjs <31481:pubkey:d> [relays] [--every 10] [--count 0] [--loc lat,lon]')
  process.exit(2)
}
const relays = (positional[1] ?? process.env.RELAYS ?? 'wss://smartcity-relay.adan0001.workers.dev').split(',')
const every = Number(opt('--every', 10))
const count = Number(opt('--count', 0))
const loc = opt('--loc', '20.6668,-103.3918').split(',').map(Number)
const sk = opt('--key', null) ? hexToBytes(opt('--key')) : generateSecretKey()

const sc = await createClient({ city: 'mx-gdl', relays, signer: localSigner(sk) })
const pubkey = await sc.pubkey()
const source = `${KIND.SOURCE}:${pubkey}:sensor-simulado`
if (!opt('--key', null)) console.log(`disposable key ${bytesToHex(sk)}`)
const reg = await sc.sources.register({ d: 'sensor-simulado', dataset, name: 'Sensor simulado', loc, hardware: 'simulado' })
console.log(`source ${source}: accepted by ${reg.accepted.join(', ') || 'none'}`)

let pm25 = 15
for (let i = 1; count === 0 || i <= count; i++) {
  pm25 = Math.max(0, Math.round((pm25 + (Math.random() - 0.5) * 6) * 10) / 10)
  const ts = Math.floor(Date.now() / 1000)
  const res = await sc.observations.publish({ dataset, source, loc, obs: [{ ts, values: { pm25 } }] })
  const at = new Date().toLocaleTimeString()
  console.log(`${at} pm25=${pm25} → ok: ${res.accepted.join(', ') || 'none'}${res.rejected.length ? ` rejected: ${JSON.stringify(res.rejected)}` : ''}`)
  if (count === 0 || i < count) await new Promise((r) => setTimeout(r, every * 1000))
}
sc.close()
process.exit(0)
