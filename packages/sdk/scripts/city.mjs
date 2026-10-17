// Herramienta de los custodios de una ciudad (docs/operacion/ciudad-piloto.md): llaves raíz, definición `city`, lista
// `roles` y datasets oficiales; también el `release` de la app que firman los desarrolladores. Redactar y firmar no usa la red, así que se puede hacer en una máquina sin conexión;
// solo `publish` habla con relays.
//
//   node scripts/city.mjs keygen --out custodio-a.ncryptsec
//   node scripts/city.mjs draft-city city.draft.json --id mx-gdl --name Guadalajara --bbox 20.55,-103.47,20.78,-103.24 \
//        --tz America/Mexico_City --relays wss://a,wss://b --roots npub1…,npub1…,npub1… [--tiles-x <sha256> --tiles-url <https>]
//   node scripts/city.mjs draft-roles roles.draft.json --id mx-gdl --entry npub1…:authority:"Ayuntamiento" --entry …
//   node scripts/city.mjs draft-dataset aire.draft.json --id mx-gdl            # calidad del aire (docs/spec/03)
//   node scripts/city.mjs draft-release release.draft.json [--file ../../apps/web/dist/smartcity.html] [--version 1.0.0]
//        [--commit <git hash>] [--channel stable|beta] --url https://…/smartcity.html --mirror https://… [--notes …]
//        [--dist-cid bafy… --dist-magnet magnet:?…]                    # versión de la app (06), firma el desarrollador
//   node scripts/city.mjs sign city.draft.json --key custodio-a.ncryptsec --out city.custodio-a.json
//   node scripts/city.mjs verify city.*.json                                    # firmas, esquema y mayoría (TRUST-12)
//   node scripts/city.mjs publish city.*.json roles.*.json [--relays wss://a,wss://b]
//
// La frase de la llave se pide por teclado (sin eco) o se toma de SC_PASSPHRASE.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { KIND, ROLES, isCityId, validateEvent } from '@smartcity/schemas'
import { decode, npubEncode } from 'nostr-tools/nip19'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { SEED_RELAYS, createClient, decryptSecretKey, encryptSecretKey, generateSecretKey, releaseTemplate } from '../dist/index.js'

const [command, ...args] = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const all = (name) => args.flatMap((a, i) => (args[i - 1] === name ? [a] : []))
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const now = () => Math.floor(Date.now() / 1000)

function fail(message) {
  console.error(message)
  process.exit(1)
}

function pubkeyOf(text) {
  const t = text.trim()
  if (/^[0-9a-f]{64}$/.test(t)) return t
  if (t.startsWith('npub1')) return decode(t).data
  fail(`not a public key: ${text}`)
}

function cityId() {
  const id = opt('--id', null)
  if (!isCityId(id)) fail('--id <city id> is required (EVT-1, e.g. mx-gdl)')
  return id
}

async function passphrase(prompt) {
  if (process.env.SC_PASSPHRASE) return process.env.SC_PASSPHRASE
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  rl._writeToOutput = (s) => {
    if (s.startsWith(prompt)) process.stdout.write(prompt)
  }
  const answer = await new Promise((resolve) => rl.question(prompt, resolve))
  rl.close()
  process.stdout.write('\n')
  return answer
}

/** A draft is what gets signed: kind, tags and the exact content string, identical for every root (TRUST-12). */
function writeDraft(path, kind, tags, content) {
  const draft = { kind, tags, content: JSON.stringify(content) }
  const check = validateEvent({ ...draft, created_at: now() })
  if (!check.ok) fail(`draft does not validate: ${check.errors.join('; ')}`)
  writeFileSync(path, `${JSON.stringify(draft, null, 2)}\n`)
  console.log(`${path}: kind ${kind}, ${draft.content.length} bytes of content`)
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

switch (command) {
  case 'keygen': {
    const out = opt('--out', null) ?? fail('--out <file> is required')
    const pass = await passphrase('Frase para cifrar la llave (12+ caracteres): ')
    if (pass.length < 12) fail('the passphrase must have at least 12 characters')
    if (!process.env.SC_PASSPHRASE && (await passphrase('Repite la frase: ')) !== pass) fail('passphrases do not match')
    const sk = generateSecretKey()
    writeFileSync(out, `${encryptSecretKey(sk, pass)}\n`)
    const pk = getPublicKey(sk)
    sk.fill(0)
    console.log(`Llave cifrada (NIP-49) en ${out}. Guarda copias fuera de línea; sin la frase no se abre.`)
    console.log(`npub: ${npubEncode(pk)}\nhex:  ${pk}`)
    break
  }

  case 'draft-city': {
    const [path] = positional
    if (!path) fail('usage: draft-city <out.json> --id … --name … --bbox … --tz … --relays … --roots …')
    const bbox = (opt('--bbox', '') ?? '').split(',').map(Number)
    const roots = (opt('--roots', '') ?? '').split(',').filter(Boolean).map(pubkeyOf)
    if (roots.length < 3) console.warn(`warning: ${roots.length} roots; TRUST-11 asks for at least 3 in different hands`)
    const relays = (opt('--relays', SEED_RELAYS.join(',')) ?? '').split(',').filter(Boolean)
    const content = {
      v: 1,
      name: opt('--name', null) ?? fail('--name is required'),
      bbox,
      tz: opt('--tz', 'America/Mexico_City'),
      relays,
      roots,
      ...(opt('--tiles-x', null) ? { tiles: { x: opt('--tiles-x'), urls: all('--tiles-url') } } : {}),
      ...(opt('--about', null) ? { about: opt('--about') } : {}),
    }
    writeDraft(path, KIND.CITY, [['d', cityId()]], content)
    break
  }

  case 'draft-roles': {
    const [path] = positional
    const id = cityId()
    const tags = [['d', id], ['c', id]]
    for (const entry of all('--entry')) {
      const [key, role, ...note] = entry.split(':')
      if (!ROLES.includes(role)) fail(`unknown role ${role}: ${ROLES.join(', ')}`)
      tags.push(['p', pubkeyOf(key), role, ...(note.length ? [note.join(':')] : [])])
    }
    writeDraft(path, KIND.ROLES, tags, { v: 1, ...(opt('--about', null) ? { about: opt('--about') } : {}) })
    break
  }

  case 'draft-dataset': {
    const [path] = positional
    // The example of docs/spec/03 for case of use 1, reusable by other cities with `c = *` if --any-city is given.
    const content = {
      v: 1,
      name: opt('--name', 'Calidad del aire'),
      description: 'Partículas, temperatura y humedad de estaciones de monitoreo, en la unidad indicada por campo.',
      license: opt('--license', 'CC0-1.0'),
      mode: 'observation',
      geometry: 'point',
      cadence_s: 300,
      model: 'https://github.com/smart-data-models/dataModel.Environment/tree/master/AirQualityObserved',
      fields: {
        pm25: { type: 'number', unit: 'ug/m3', min: 0, max: 1000, description: 'PM2.5' },
        pm10: { type: 'number', unit: 'ug/m3', min: 0, max: 2000, description: 'PM10' },
        temp: { type: 'number', unit: 'Cel', min: -40, max: 60 },
        rh: { type: 'number', unit: '%', min: 0, max: 100 },
      },
    }
    const city = args.includes('--any-city') ? '*' : cityId()
    writeDraft(path, KIND.DATASET, [['d', opt('--d', 'air-quality')], ['c', city], ['t', 'ambiente']], content)
    break
  }

  case 'draft-release': {
    const [path] = positional
    if (!path) fail('usage: draft-release <out.json> --url https://…/smartcity.html [--mirror …] (see the header)')
    // APP-4: the single file is the referenced artifact; its sha256 goes in `x` and `single.x` (DIST-2).
    const file = opt('--file', fileURLToPath(new URL('../../../apps/web/dist/smartcity.html', import.meta.url)))
    const bytes = readFileSync(file)
    const version = opt('--version', null) ?? readJson(fileURLToPath(new URL('../../../apps/web/package.json', import.meta.url))).version
    let commit = opt('--commit', null)
    if (!commit) {
      try {
        commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      } catch {
        fail('--commit <git hash> is required outside a git checkout')
      }
    }
    const dist = {
      ...(opt('--dist-cid', null) ? { cid: opt('--dist-cid') } : {}),
      ...(opt('--dist-magnet', null) ? { magnet: opt('--dist-magnet') } : {}),
    }
    let template
    try {
      template = releaseTemplate({
        channel: opt('--channel', 'stable'),
        version,
        commit,
        single: { x: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, urls: all('--url') },
        dist,
        mirrors: all('--mirror'),
        notes: opt('--notes', undefined),
      })
    } catch (e) {
      fail(e.message)
    }
    if (all('--url').length === 0) console.warn('warning: no --url; the file can only be found by its hash (torrent, IPFS, copies)')
    writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`)
    console.log(`${path}: ${version} (${commit.slice(0, 12)}), ${file}: ${bytes.length} bytes, sha256 ${JSON.parse(template.content).single.x}`)
    break
  }

  case 'sign': {
    const [path] = positional
    const draft = readJson(path)
    const key = readFileSync(opt('--key', null) ?? fail('--key <ncryptsec file> is required'), 'utf8').trim()
    let sk
    try {
      sk = decryptSecretKey(key, await passphrase('Frase de la llave: '))
    } catch {
      fail('wrong passphrase')
    }
    const event = finalizeEvent({ kind: draft.kind, tags: draft.tags, content: draft.content, created_at: now() }, sk)
    sk.fill(0)
    const out = opt('--out', path.replace(/\.draft\.json$|\.json$/, `.${event.pubkey.slice(0, 8)}.json`))
    writeFileSync(out, `${JSON.stringify(event, null, 2)}\n`)
    console.log(`${out}: signed by ${npubEncode(event.pubkey)}`)
    break
  }

  case 'verify': {
    const events = positional.map(readJson)
    let ok = true
    for (const [i, e] of events.entries()) {
      const schema = validateEvent(e)
      const sig = verifyEvent(e)
      if (!schema.ok || !sig) ok = false
      console.log(`${positional[i]}: kind ${e.kind} by ${npubEncode(e.pubkey)} · signature ${sig ? 'ok' : 'BAD'} · schema ${schema.ok ? 'ok' : schema.errors.join('; ')}`)
    }
    // TRUST-12: the same definition, byte for byte, signed by a strict majority of the roots it names.
    const cities = events.filter((e) => e.kind === KIND.CITY)
    if (cities.length > 0) {
      const contents = new Set(cities.map((e) => e.content))
      if (contents.size > 1) {
        ok = false
        console.log('city: the definitions differ; every root must sign the same content (TRUST-12)')
      }
      const roots = JSON.parse(cities[0].content).roots
      const signers = new Set(cities.filter((e) => roots.includes(e.pubkey)).map((e) => e.pubkey))
      const majority = signers.size * 2 > roots.length
      console.log(`city: signed by ${signers.size} of its ${roots.length} roots${majority ? ' (strict majority)' : ' — no strict majority yet'}`)
      for (const e of cities) if (!roots.includes(e.pubkey)) console.log(`city: ${npubEncode(e.pubkey)} is not one of its roots`)
    }
    process.exit(ok ? 0 : 1)
    break
  }

  case 'publish': {
    const relays = (opt('--relays', SEED_RELAYS.join(',')) ?? '').split(',')
    const sc = await createClient({ city: 'xx-none', relays }) // only sends; the city id is not used
    for (const path of positional) {
      const res = await sc.send(readJson(path)).catch((e) => fail(`${path}: ${e.message}; nothing published`))
      console.log(`${path}: accepted by ${res.accepted.join(', ') || 'none'}${res.rejected.length ? ` · rejected ${JSON.stringify(res.rejected)}` : ''}`)
    }
    sc.close()
    process.exit(0)
    break
  }

  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'))
    process.exit(command ? 2 : 0)
}
