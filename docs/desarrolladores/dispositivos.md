# Dispositivos y procesos que publican solos

Guía para desarrolladores de fuera del proyecto (GOAL-1): un sensor, un microcontrolador o un script que publica sin que nadie lo opere tiene **su propia llave**, distinta de la de su dueño. El dueño la lista en `keys` de su `source` y así las lecturas firmadas por el dispositivo cuentan como de esa fuente (ID-5). Todo con [`nostr-tools`](https://github.com/nbd-wtf/nostr-tools) y la API HTTP del relay, sin código de este repositorio. Lo normativo está en [`03`](../spec/03-modelo-de-eventos.md), [`04`](../spec/04-identidad-y-confianza.md) y [`05`](../spec/05-integracion-de-apps.md) («Dispositivos que firman», «Agentes de IA y scripts»).

Se parte de un dataset ya definido, propio o ajeno; cómo definirlo está en [Publicar y consumir un dataset propio](primer-dataset.md).

## Por qué una llave por dispositivo

- **El dueño no expone la suya.** La llave del dueño firma la fuente y sus datasets; si viviera en el dispositivo, quien lo abra podría reemplazarlos. La del dispositivo solo sirve para lecturas de esa fuente.
- **Se revoca sin cambiar nada más.** Si el dispositivo se pierde o se vulnera, el dueño publica la fuente otra vez sin esa llave en `keys`: la fuente es direccionable y la versión nueva reemplaza a la anterior (DATA-3). Las lecturas viejas siguen firmadas, pero quien lee ya no las atribuye a la fuente.
- **Declara que es un proceso.** Quien publica sin intervención humana DEBE usar una llave propia y una ficha `app` con `"automated": true` (`05`).

## Los eventos

| Evento | Kind | Quién lo firma | Para qué |
|---|---|---|---|
| `source` | 31482 | El dueño | La fuente, con la pubkey del dispositivo en `keys` |
| `app` | 31483 | El dispositivo | Ficha del proceso: qué datasets escribe, `automated: true` |
| `observation` | 1480 | El dispositivo | Un lote de lecturas, con el `a` de la fuente |

## El script completo

Un dispositivo genera su llave, el dueño publica la fuente que la autoriza, el dispositivo publica su ficha y un lote de tres lecturas, y quien lee comprueba que cada lectura la firma alguien que la fuente autoriza. Se puede copiar tal cual a un archivo `.mjs` y correr con `node`; en un microcontrolador el flujo es el mismo con su librería de firma Schnorr.

<!-- Este bloque se ejecuta contra el relay de referencia en services/relay-worker/test/guide.test.ts. -->

```js
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'

const RELAYS = ['https://smartcity-relay.adan0001.workers.dev', 'https://smartcity-relay-b.adan0001.workers.dev']
const CITY = 'mx-gdl'
const KIND = { observation: 1480, dataset: 31481, source: 31482, app: 31483 }

const now = () => Math.floor(Date.now() / 1000)

// Geohash estándar; los tres tags g del mismo punto (EVT-3).
function geohash(lat, lon, precision) {
  const alphabet = '0123456789bcdefghjkmnpqrstuvwxyz'
  const range = { lat: [-90, 90], lon: [-180, 180] }
  let hash = ''
  let bits = 0
  let value = 0
  let useLon = true
  while (hash.length < precision) {
    const [axis, coord] = useLon ? ['lon', lon] : ['lat', lat]
    const mid = (range[axis][0] + range[axis][1]) / 2
    value = value * 2 + (coord >= mid ? 1 : 0)
    range[axis][coord >= mid ? 0 : 1] = mid
    useLon = !useLon
    if (++bits === 5) {
      hash += alphabet[value]
      bits = 0
      value = 0
    }
  }
  return hash
}
const geoTags = ([lat, lon]) => [4, 5, 6].map((p) => ['g', geohash(lat, lon, p)])

const sign = (sk, kind, tags, content) => finalizeEvent({ kind, tags, content: JSON.stringify(content), created_at: now() }, sk)

// Envía un evento firmado a todos los relays; basta con que uno lo acepte.
async function post(event) {
  const answers = await Promise.allSettled(
    RELAYS.map(async (relay) => {
      const res = await fetch(`${relay}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      })
      const body = await res.json()
      if (!body.ok) throw new Error(`${relay}: ${body.reason}`)
    }),
  )
  if (!answers.some((a) => a.status === 'fulfilled')) {
    throw new Error(answers.map((a) => a.reason.message).join('; '))
  }
}

// Eventos de todos los relays, verificados y sin duplicados.
async function query(params) {
  const found = new Map()
  for (const relay of RELAYS) {
    const res = await fetch(`${relay}/v1/events?${new URLSearchParams({ limit: '500', ...params })}`)
    for (const line of (await res.text()).split('\n')) {
      if (!line) continue
      const event = JSON.parse(line)
      if (!found.has(event.id) && verifyEvent(event)) found.set(event.id, event)
    }
  }
  return [...found.values()]
}

// 1. En el dispositivo, al primer arranque: su llave. No sale de él; solo se muestra la pubkey (serial o QR).
const deviceSk = generateSecretKey()
const devicePk = getPublicKey(deviceSk)

// 2. En la computadora del dueño, una vez: la fuente autoriza esa pubkey en keys (ID-5).
const ownerSk = generateSecretKey() // en la práctica, tu llave de siempre
const ownerPk = getPublicKey(ownerSk)
const dataset = `${KIND.dataset}:${ownerPk}:ruido` // el de la otra guía; puede ser de otra persona
const loc = [20.6668, -103.3918]
await post(
  sign(ownerSk, KIND.source, [['d', 'balcon-01'], ['c', CITY], ['a', dataset], ...geoTags(loc)], {
    v: 1,
    name: 'Balcón',
    loc,
    hardware: 'ESP32 + micrófono',
    status: 'active',
    keys: [devicePk],
  }),
)
const source = `${KIND.source}:${ownerPk}:balcon-01`

// 3. El dispositivo declara que es un proceso automático y qué escribe (05).
await post(
  sign(deviceSk, KIND.app, [['d', 'balcon-01'], ['c', CITY], ['a', dataset]], {
    v: 1,
    name: 'Sensor de ruido del balcón',
    urls: [],
    writes: [dataset],
    reads: [],
    automated: true,
  }),
)

// 4. El dispositivo, en bucle: acumula lecturas y cada N minutos envía un solo evento (DATA-9).
const pending = []
const measure = (laeq) => pending.push({ ts: now(), values: { laeq } })

async function flush() {
  // Sin hora no se firma: los relays rechazan lo que llega con más de 15 min de adelanto (DATA-4). Sincroniza por NTP.
  if (now() < 1_700_000_000) throw new Error('reloj sin sincronizar')
  const obs = pending.slice(0, 500)
  if (obs.length === 0) return
  await post(sign(deviceSk, KIND.observation, [['c', CITY], ['a', dataset], ['a', source], ...geoTags(loc)], { v: 1, loc, obs }))
  pending.splice(0, obs.length) // si ningún relay aceptó, post lanzó y las lecturas esperan al siguiente intento
}

measure(54.3)
measure(55.1)
measure(53.8)
await flush()

// 5. Quien lee: una lectura es de la fuente si la firma su dueño o una llave de keys en la versión vigente de la fuente.
const sources = new Map()
async function authorized(address, pubkey) {
  const [, owner, d] = address.split(':')
  if (pubkey === owner) return true
  if (!sources.has(address)) {
    const versions = await query({ kinds: String(KIND.source), authors: owner, d })
    // Gana la más reciente; a igual fecha, el id menor (DATA-3).
    versions.sort((x, y) => y.created_at - x.created_at || (x.id < y.id ? -1 : 1))
    sources.set(address, versions[0] ? JSON.parse(versions[0].content).keys ?? [] : [])
  }
  return sources.get(address).includes(pubkey)
}

const readings = await query({ kinds: String(KIND.observation), c: CITY, a: dataset })
readings.sort((x, y) => x.created_at - y.created_at || (x.id < y.id ? -1 : 1))
for (const event of readings) {
  const address = event.tags.find(([name, value]) => name === 'a' && value.startsWith(`${KIND.source}:`))?.[1]
  const ok = address !== undefined && (await authorized(address, event.pubkey))
  for (const { ts, values } of JSON.parse(event.content).obs) {
    console.log(ok ? 'de la fuente' : 'sin autorizar', new Date(ts * 1000).toISOString(), values)
  }
}
```

Sale una línea por lectura, por ejemplo `de la fuente 2026-10-19T10:40:12.000Z { laeq: 54.3 }`. Una lectura que dice ser del balcón pero la firma una llave que la fuente no lista sale como `sin autorizar`: cualquiera puede poner el `a` de una fuente ajena, así que la etiqueta no prueba nada sin la firma.

## Lo que conviene saber

- **Confianza:** que la lectura sea de la fuente no la hace `verified`. Lo es si además el dueño de la fuente tiene un rol atestiguado por un ancla de la ciudad (`04`); si no, es `community`. Cómo calcular los roles: [Reportes ciudadanos y en quién confiar](reportes.md).
- **Revocar:** publica la fuente otra vez sin la llave en `keys`. Para retirar el dispositivo del todo, `status: "retired"`.
- **Sin conexión:** si ningún relay acepta el lote, el dispositivo lo conserva y lo reenvía en el siguiente ciclo, sin pasar de 500 lecturas ni 64 KB por evento (DATA-9). Cada lectura lleva su `ts`, así que el momento real no depende de cuándo se envía.
- **Lotes muy viejos:** un relay puede rechazar con `invalid: too old` un evento firmado hace más de 30 días (RELAY-5). Vuelve a firmar el mismo lote con la fecha actual; el `ts` de cada lectura no cambia.
- **Tasa:** el relay limita los eventos por llave y minuto (`rate-limited:`). Un lote cada pocos minutos queda muy por debajo.
- **Varios relays:** envía a 2 o 3 (REPL-1). `POST /v1/events` es propio del relay de referencia; con otro relay Nostr se envía `["EVENT", …]` por WebSocket ([Publicar y consumir un dataset propio](primer-dataset.md#en-vivo-por-websocket)).
- **Privacidad:** si el dispositivo está en un domicilio, publica la ubicación redondeada a 3 decimales (PRIV-9) y no pongas en `name` ni en `hardware` nada que identifique a quien vive ahí (`08`).
