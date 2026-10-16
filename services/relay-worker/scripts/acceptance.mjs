// End-to-end acceptance tests of docs/spec/07 (1–6 and 9) against a running relay.
// Usage: node scripts/acceptance.mjs [relay-url]   (default http://127.0.0.1:8787, `pnpm dev`)
import { execFileSync } from 'node:child_process'
import { KIND, NOSTR_KIND } from '@smartcity/schemas'
import { SimplePool } from 'nostr-tools/pool'
import { CITY, Client, airDataset, dataset, key, now, observation, relayUrls, sign } from './lib.mjs'

const { http, ws } = relayUrls(process.argv[2])
const results = []

async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true })
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ''}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sameIds = (a, b) => JSON.stringify(a.map((e) => e.id).sort()) === JSON.stringify(b.map((e) => e.id).sort())

async function getEvents(params) {
  const res = await fetch(`${http}/v1/events?${new URLSearchParams(params)}`)
  assert(res.ok, `GET /v1/events → ${res.status}`)
  return (await res.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

console.log(`relay: ${http}`)

const a = await Client.open(ws)
const b = await Client.open(ws)
const author = key()

await check('NIP-11 and CORS', async () => {
  const res = await fetch(http, { headers: { Accept: 'application/nostr+json' } })
  const info = await res.json()
  assert(res.headers.get('access-control-allow-origin') === '*', 'missing Access-Control-Allow-Origin: *')
  assert(info.supported_nips.includes(1) && info.limitation.max_limit === 1000, 'unexpected NIP-11 document')
  return `max_event_age_days=${info.smartcity.max_event_age_days}`
})

await check('1. valid event over WebSocket → OK true; a second subscribed client receives it in < 1 s', async () => {
  await b.req('live', { kinds: [KIND.OBSERVATION], authors: [author.pk], since: now() - 60 })
  const event = observation(author.sk, author.pk, 10)
  const start = performance.now()
  const delivered = b.wait((m) => m[0] === 'EVENT' && m[1] === 'live' && m[2].id === event.id, 1000)
  const ok = await a.publish(event)
  assert(ok.ok && ok.message === '', `OK ${ok.ok} "${ok.message}"`)
  await delivered
  return `${Math.round(performance.now() - start)} ms`
})

await check('2. same event again → OK true with duplicate:, no new row', async () => {
  const event = observation(author.sk, author.pk, 1, now() - 5)
  await a.publish(event)
  const again = await a.publish(event)
  assert(again.ok && again.message.startsWith('duplicate:'), `OK ${again.ok} "${again.message}"`)
  const stored = await getEvents({ ids: event.id })
  assert(stored.length === 1, `${stored.length} copies stored`)
})

await check('3. altered signature, invalid schema, future date, foreign kind → OK false with the right prefix', async () => {
  const good = observation(author.sk, author.pk)
  const cases = [
    ['invalid:', { ...good, sig: (good.sig[0] === '0' ? '1' : '0') + good.sig.slice(1) }],
    ['invalid:', sign(author.sk, KIND.OBSERVATION, [['c', CITY], ['a', airDataset(author.pk)]], { v: 1, obs: [] })],
    ['invalid:', observation(author.sk, author.pk, 1, now() + 3600)],
    ['blocked:', sign(author.sk, 1, [], 'hola')],
  ]
  for (const [prefix, event] of cases) {
    const r = await a.publish(event)
    assert(!r.ok && r.message.startsWith(prefix), `expected ${prefix}, got OK ${r.ok} "${r.message}"`)
  }
})

await check('4. newer addressable replaces; older is discarded', async () => {
  const owner = key()
  const t = now()
  await a.publish(dataset(owner.sk, 'v1', t - 100))
  const v2 = dataset(owner.sk, 'v2', t - 50)
  assert((await a.publish(v2)).ok, 'v2 rejected')
  const old = await a.publish(dataset(owner.sk, 'v0', t - 200))
  assert(old.ok && old.message.startsWith('duplicate:'), `older: OK ${old.ok} "${old.message}"`)
  const stored = await a.req('ds', { kinds: [KIND.DATASET], authors: [owner.pk], '#d': ['air-quality'] })
  assert(stored.length === 1 && stored[0].id === v2.id, 'stored version is not v2')
})

await check("5. kind 5 from the author deletes; from another key it does not", async () => {
  const owner = key()
  const intruder = key()
  const mine = observation(owner.sk, owner.pk, 1, now() - 30)
  const other = observation(owner.sk, owner.pk, 1, now() - 20)
  await a.publish(mine)
  await a.publish(other)
  assert((await a.publish(sign(intruder.sk, NOSTR_KIND.DELETION, [['e', other.id]], ''))).ok, 'foreign kind 5 rejected')
  assert((await a.publish(sign(owner.sk, NOSTR_KIND.DELETION, [['e', mine.id]], ''))).ok, 'kind 5 rejected')
  const left = await getEvents({ ids: `${mine.id},${other.id}` })
  assert(left.length === 1 && left[0].id === other.id, `left: ${left.map((e) => e.id.slice(0, 8))}`)
})

await check('6. GET /v1/events and REQ with the same filter return the same set', async () => {
  const filter = { kinds: [KIND.OBSERVATION], authors: [author.pk], '#c': [CITY], limit: 50 }
  const viaReq = await a.req('same', filter)
  const viaHttp = await getEvents({ kinds: KIND.OBSERVATION, authors: author.pk, c: CITY, limit: 50 })
  assert(viaReq.length > 0 && sameIds(viaReq, viaHttp), `REQ ${viaReq.length} vs HTTP ${viaHttp.length}`)
  return `${viaReq.length} events`
})

await check('POST /v1/events publishes and the hub delivers it to subscribers', async () => {
  const sender = key()
  await b.req('http', { authors: [sender.pk] })
  const event = observation(sender.sk, sender.pk)
  const delivered = b.wait((m) => m[0] === 'EVENT' && m[1] === 'http' && m[2].id === event.id, 2000)
  const res = await fetch(`${http}/v1/events`, { method: 'POST', body: JSON.stringify(event) })
  const body = await res.json()
  assert(res.status === 200 && body.ok && body.id === event.id, JSON.stringify(body))
  await delivered
  const bad = await fetch(`${http}/v1/events`, { method: 'POST', body: JSON.stringify({ ...event, id: 'x' }) })
  assert(bad.status === 400 && (await bad.json()).reason.startsWith('invalid:'), 'invalid event not rejected with 400')
})

await check('9. a generic Nostr client publishes and queries without adaptations', async () => {
  const generic = key()
  const pool = new SimplePool()
  try {
    const event = observation(generic.sk, generic.pk)
    await Promise.all(pool.publish([ws], event))
    const found = await pool.querySync([ws], { ids: [event.id] })
    assert(found.length === 1, 'nostr-tools SimplePool could not read its own event back')
  } finally {
    pool.close([ws])
  }
  try {
    execFileSync('nak', ['--version'], { stdio: 'ignore' })
  } catch {
    return 'nostr-tools SimplePool; nak not installed, run it by hand'
  }
  const out = execFileSync('nak', ['req', '-k', String(KIND.OBSERVATION), '-l', '1', ws], { encoding: 'utf8' })
  assert(out.trim().length > 0, 'nak got nothing')
  return 'nostr-tools SimplePool and nak'
})

a.close()
b.close()
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
