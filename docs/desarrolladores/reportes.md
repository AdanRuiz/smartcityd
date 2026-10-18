# Reportes ciudadanos y en quién confiar

Guía para desarrolladores de fuera del proyecto (GOAL-1), continuación de [Publicar y consumir un dataset propio](primer-dataset.md). Una app publica un reporte ciudadano (un bache, una luminaria fundida) con una llave desechable y lee después su estado oficial, decidiendo ella misma qué llaves hablan por la ciudad. Solo hace falta [`nostr-tools`](https://github.com/nbd-wtf/nostr-tools) y `fetch`. Lo normativo está en [`03`](../spec/03-modelo-de-eventos.md) (formatos), [`04`](../spec/04-identidad-y-confianza.md) (roles y niveles de confianza) y [`08`](../spec/08-seguridad-y-privacidad.md) (privacidad).

## Los tres eventos

| Evento | Kind | Quién lo firma | Tags |
|---|---|---|---|
| `report` | 1481 | Quien reporta, con una llave nueva por reporte | `c` (ciudad), `t` (categoría), tres `g` |
| `report_update` | 1483 | Cualquiera: la autoridad, un operador, un vecino | `c`, `e` (id del reporte), `p` (autor del reporte) |
| `roles` | 31484 | Un ancla de confianza de la ciudad | `d` y `c` (la ciudad), un `p` por llave: `["p", <pubkey>, <rol>]` |

Categorías iniciales (`t`): `bache`, `alumbrado`, `fuga`, `basura`, `semaforo`, `arbolado`, `otro`; una app puede usar otras. El `content` de un `report` lleva `title` (hasta 120 caracteres), `body` opcional (hasta 2000) y `loc`; el de un `report_update` lleva `status`, `body` o los dos. Estados: `open`, `ack`, `in_progress`, `resolved`, `rejected`, `duplicate`.

## En quién confiar

Cualquiera puede publicar un `report_update` con `status: "resolved"`. Lo que lo vuelve oficial es que su autor tenga rol `authority` u `operator` en la ciudad, y eso lo decide quien lee, no el relay (TRUST-7):

1. **Anclas.** Tu app fija las pubkeys raíz de cada ciudad que conoce (TRUST-1). Vienen en la definición `city` (kind 31480) que firman sus custodios, pero cualquiera puede firmar un `city` con el mismo `d`: compruébalas por un canal externo a la red (sitio oficial, gaceta) y escríbelas en tu código o configuración. Nunca las elijas solo porque aparecen en un relay (TRUST-3).
2. **Roles.** Cada ancla publica una lista `roles`. Solo cuentan las firmadas por tus anclas (TRUST-4); de cada ancla vale la más reciente. Las anclas mismas hablan por la ciudad.
3. **Niveles.** Con eso, cada evento recibe un nivel: `verified` si su autor tiene un rol, `flagged` si tiene el rol `blocked` (se oculta por defecto) y `community` en otro caso.
4. **Estado vigente.** El `status` del `report_update` más reciente de una llave `authority` u `operator`; si no hay ninguno, `open`. Los demás se muestran como comentarios, aunque traigan `status` (docs/spec/03).

## El script completo

Publica un bache en los dos relays de referencia con una llave desechable y lee sus actualizaciones: el estado oficial y los comentarios, cada uno con su nivel. Se puede copiar tal cual a un archivo `.mjs` y correr con `node`. Las raíces de la ciudad piloto aún no se publican: mientras `ROOTS` esté vacío, nadie habla por la ciudad, todo es `community` y el estado se queda en `open`.

<!-- Este bloque se ejecuta contra el relay de referencia en services/relay-worker/test/guide.test.ts. -->

```js
import { minePow } from 'nostr-tools/nip13'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'

const RELAYS = ['https://smartcity-relay.adan0001.workers.dev', 'https://smartcity-relay-b.adan0001.workers.dev']
const CITY = 'mx-gdl'
const KIND = { report: 1481, report_update: 1483, roles: 31484 }
// Tus anclas: las pubkeys raíz de la ciudad en hex, comprobadas fuera de la red (TRUST-1).
const ROOTS = []
// Prueba de trabajo NIP-13 que los relays de referencia piden a un reporte de una llave sin rol (SPAM-1).
const POW_BITS = 16

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

// Lo mismo de todos los relays, con firma válida y sin duplicados.
async function query(params) {
  const events = new Map()
  for (const relay of RELAYS) {
    try {
      const res = await fetch(`${relay}/v1/events?${new URLSearchParams(params)}`)
      for (const line of (await res.text()).split('\n')) {
        if (!line) continue
        const event = JSON.parse(line)
        if (verifyEvent(event)) events.set(event.id, event)
      }
    } catch (error) {
      console.warn(`${relay}: ${error.message}`)
    }
  }
  return [...events.values()]
}

// 1. El reporte, con una llave nueva que no se vuelve a usar: nadie puede unir tus reportes (PRIV-5).
//    La ubicación es pública: redondeada a 4 decimales, unos 11 m (PRIV-3).
const sk = generateSecretKey()
const loc = [20.666812, -103.39179].map((x) => Math.round(x * 1e4) / 1e4)
const unsigned = {
  kind: KIND.report,
  pubkey: getPublicKey(sk),
  created_at: now(),
  tags: [['c', CITY], ['t', 'bache'], ...geoTags(loc)],
  content: JSON.stringify({ v: 1, title: 'Bache en el carril derecho', body: 'Frente al número 120.', loc }),
}
// La prueba de trabajo va antes de firmar: añade un tag nonce y cambia el id. El mismo evento va a todos los relays.
const report = finalizeEvent(minePow(unsigned, POW_BITS), sk)
const answers = await Promise.allSettled(
  RELAYS.map(async (relay) => {
    const res = await fetch(`${relay}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    })
    const body = await res.json()
    if (!body.ok) throw new Error(`${relay}: ${body.reason}`)
  }),
)
if (!answers.some((a) => a.status === 'fulfilled')) throw new Error(answers.map((a) => a.reason.message).join('; '))
console.log('Reporte publicado:', report.id)

// 2. Quién es quién: la lista roles más reciente de cada ancla, y solo de ellas (TRUST-4).
const lists = new Map()
if (ROOTS.length > 0) {
  for (const event of await query({ kinds: String(KIND.roles), authors: ROOTS.join(','), d: CITY })) {
    const current = lists.get(event.pubkey)
    const newer = !current || event.created_at > current.created_at
    if (newer || (event.created_at === current.created_at && event.id < current.id)) lists.set(event.pubkey, event)
  }
}
const ROLES = ['authority', 'operator', 'app', 'source', 'archiver', 'moderator', 'blocked']
const roles = new Map(ROOTS.map((pubkey) => [pubkey, new Set(['authority'])]))
for (const list of lists.values()) {
  for (const [name, pubkey, role] of list.tags) {
    if (name !== 'p' || !pubkey || !ROLES.includes(role)) continue
    if (!roles.has(pubkey)) roles.set(pubkey, new Set())
    roles.get(pubkey).add(role)
  }
}
const level = (pubkey) => (roles.get(pubkey)?.has('blocked') ? 'flagged' : roles.has(pubkey) ? 'verified' : 'community')
const official = (pubkey) =>
  level(pubkey) === 'verified' && (roles.get(pubkey).has('authority') || roles.get(pubkey).has('operator'))

// 3. Las actualizaciones en orden; el estado lo fija la más reciente de authority u operator (docs/spec/03).
const updates = (await query({ kinds: String(KIND.report_update), c: CITY, e: report.id })).sort(
  (a, b) => a.created_at - b.created_at || (a.id < b.id ? 1 : -1),
)
let status = 'open'
for (const update of updates) {
  if (level(update.pubkey) === 'flagged') continue // oculto por defecto
  const content = JSON.parse(update.content)
  if (content.status && official(update.pubkey)) {
    status = content.status
    console.log(`oficial: ${content.status}`, content.body ?? '')
  } else {
    console.log(`comentario (${level(update.pubkey)})`, content.body ?? content.status)
  }
}
console.log(`Estado vigente: ${status}`)
```

Sale primero el id del reporte, luego una línea por actualización visible y al final el estado, por ejemplo `oficial: in_progress Cuadrilla asignada` y `Estado vigente: in_progress`.

## Para la autoridad o el operador

Quien tiene el rol publica el cambio de estado con su llave estable, citando el reporte y a su autor. No necesita prueba de trabajo: solo se pide a reportes de llaves sin rol.

```js
const update = finalizeEvent(
  {
    kind: 1483,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['c', 'mx-gdl'], ['e', report.id], ['p', report.pubkey]],
    content: JSON.stringify({ v: 1, status: 'resolved', body: 'Bacheo terminado.' }),
  },
  authoritySecretKey,
)
```

Y se envía igual que el reporte. Un evento no se edita (es inmutable): para corregir un estado se publica otro `report_update` más reciente.

## Lo que conviene saber

- **Antes de la primera publicación:** avisa una vez a quien reporta que lo publicado es público, va firmado y no se puede borrar con garantía (PRIV-6). Nada de nombres, teléfonos, matrículas ni direcciones de personas en `title` o `body` (PRIV-1).
- **Llave desechable:** el script no guarda `sk`, así que nadie, ni quien reportó, puede publicar después con esa llave. Si tu app ofrece seguimiento o borrado (kind 5) del propio reporte, guarda la llave de cada reporte en el dispositivo, nunca una sola para todos (PRIV-5).
- **Prueba de trabajo:** 16 bits son unas 65 000 pruebas de hash, entre décimas de segundo y unos segundos. En el navegador hazla en un Web Worker, no en el hilo de la interfaz (SPAM-1). Un relay que pide más responde `pow: difficulty <n> required`; su documento NIP-11 (`GET /` con `Accept: application/nostr+json`) lo dice en `smartcity.pow_bits_report`.
- **Listar reportes:** `kinds=1481&c=mx-gdl&t=bache&g=9ewmx` da los baches de una celda geohash; para un área se piden las celdas que la cubren y se recorta en el cliente. Las actualizaciones de varios reportes se piden juntas: `kinds=1483&e=<id1>,<id2>`.
- **Moderación:** además de `blocked`, una etiqueta (kind 1985) o una denuncia (kind 1984) de una llave con rol `moderator` vuelve `flagged` lo que señala. Ver [`08`](../spec/08-seguridad-y-privacidad.md).
- **Cambio de anclas:** si cambias las anclas de una ciudad, las listas `roles` de las anteriores dejan de contar en ese momento (TRUST-10); recalcula los niveles, no los guardes.
- **Fotos:** no van en el evento. Se suben aparte y el reporte las cita en `attachments` por su sha256 (DATA-11); antes se les quita el EXIF y se redimensionan (PRIV-4).
