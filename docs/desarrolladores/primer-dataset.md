# Publicar y consumir un dataset propio

Guía para desarrolladores de fuera del proyecto (GOAL-1): con un par de llaves y la librería pública [`nostr-tools`](https://github.com/nbd-wtf/nostr-tools) una app define un dataset nuevo, registra una fuente, publica lecturas y las lee de vuelta. No hace falta alta, cuenta ni aprobación, ni código de este repositorio. Lo normativo está en la especificación: formatos en [`03`](../spec/03-modelo-de-eventos.md), vías de integración en [`05`](../spec/05-integracion-de-apps.md) y API HTTP del relay en [`07`](../spec/07-relay-referencia.md).

## Antes de empezar

- Node 20 o posterior (trae `fetch`) y `npm install nostr-tools`. En el navegador funciona igual.
- Una ciudad: su ID es `<país>-<slug>` (EVT-1), por ejemplo `mx-gdl`. Los relays recomendados de una ciudad vienen en su evento `city` (kind 31480); aquí se usan los dos relays de referencia.
- Todo dato es un evento Nostr firmado (NIP-01). Los relays verifican `id`, firma y esquema, y rechazan lo que no cumpla con un prefijo (`invalid:`, `rate-limited:`, `pow:`, `blocked:`, `restricted:`). Quien lee DEBE verificar también: nunca confíes en el transporte.

## Los tres eventos

| Evento | Kind | Para qué | Tags |
|---|---|---|---|
| `dataset` | 31481 | Declara el tipo de dato: campos, unidades, licencia | `d` (slug), `c` (ciudad o `*`), `t` (categoría) |
| `source` | 31482 | Registra un sensor o proceso | `d`, `c`, `a` (dirección del dataset), tres `g` si es fija |
| `observation` | 1480 | Una o varias lecturas | `c`, `a` del dataset, `a` de la fuente, tres `g` |

`dataset` y `source` son direccionables: publicar otro con el mismo `d` reemplaza al anterior. Su dirección es `<kind>:<tu pubkey>:<d>` (EVT-2), así que tu dataset `ruido` no choca con el `ruido` de otra persona. Una `observation` es inmutable: para corregirla se publica otra.

La ubicación va en el `content` como `[lat, lon]` con hasta 6 decimales (EVT-4) y, para poder consultarla por zona, en tres tags `g` con el geohash del mismo punto a precisión 4, 5 y 6 (EVT-3). Los tiempos son segundos Unix enteros (EVT-5).

## El script completo

Define un dataset de ruido ambiental, registra una fuente en un balcón, publica una lectura en los dos relays y la lee de vuelta por HTTP. Se puede copiar tal cual a un archivo `.mjs` y correr con `node`.

<!-- Este bloque se ejecuta contra el relay de referencia en services/relay-worker/test/guide.test.ts. -->

```js
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'

const RELAYS = ['https://smartcity-relay.adan0001.workers.dev', 'https://smartcity-relay-b.adan0001.workers.dev']
const CITY = 'mx-gdl'
const KIND = { observation: 1480, dataset: 31481, source: 31482 }

// Tu identidad. Guárdala: con otra llave el dataset sería otro (EVT-2).
const sk = generateSecretKey()
const pk = getPublicKey(sk)
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

// Firma y envía a todos los relays; basta con que uno lo acepte.
async function publish(kind, tags, content) {
  const event = finalizeEvent({ kind, tags, content: JSON.stringify(content), created_at: now() }, sk)
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
  return event
}

// 1. El dataset: qué se mide y con qué licencia.
await publish(KIND.dataset, [['d', 'ruido'], ['c', CITY], ['t', 'ambiente']], {
  v: 1,
  name: 'Ruido ambiental',
  license: 'CC0-1.0',
  mode: 'observation',
  geometry: 'point',
  cadence_s: 600,
  fields: { laeq: { type: 'number', unit: 'dB', min: 0, max: 200 } },
})
const dataset = `${KIND.dataset}:${pk}:ruido`

// 2. La fuente: dónde está el sensor.
const loc = [20.6668, -103.3918]
await publish(KIND.source, [['d', 'balcon-01'], ['c', CITY], ['a', dataset], ...geoTags(loc)], {
  v: 1,
  name: 'Balcón',
  loc,
  status: 'active',
})
const source = `${KIND.source}:${pk}:balcon-01`

// 3. Las lecturas: hasta 500 por evento, cada una con su momento.
await publish(KIND.observation, [['c', CITY], ['a', dataset], ['a', source], ...geoTags(loc)], {
  v: 1,
  loc,
  obs: [{ ts: now(), values: { laeq: 54.3 } }],
})

// 4. Leer: las observaciones de tu dataset, de todos los relays, verificadas y sin duplicados.
const seen = new Set()
for (const relay of RELAYS) {
  const query = new URLSearchParams({ kinds: String(KIND.observation), c: CITY, a: dataset, limit: '500' })
  const res = await fetch(`${relay}/v1/events?${query}`)
  for (const line of (await res.text()).split('\n')) {
    if (!line) continue
    const event = JSON.parse(line)
    if (seen.has(event.id) || !verifyEvent(event)) continue
    seen.add(event.id)
    for (const { ts, values } of JSON.parse(event.content).obs) {
      console.log(new Date(ts * 1000).toISOString(), values)
    }
  }
}
```

Sale una línea por lectura, por ejemplo `2026-10-18T19:40:12.000Z { laeq: 54.3 }`.

## En vivo por WebSocket

Para recibir cada lectura nueva al llegar, se suscribe con un filtro NIP-01 (los tags van con `#`). El relay manda primero lo almacenado y después lo nuevo:

```js
import { SimplePool } from 'nostr-tools/pool'

const pool = new SimplePool() // verifica id y firma de cada evento recibido
pool.subscribeMany(
  ['wss://smartcity-relay.adan0001.workers.dev', 'wss://smartcity-relay-b.adan0001.workers.dev'],
  { kinds: [1480], '#c': ['mx-gdl'], '#a': [dataset] },
  { onevent: (event) => console.log(JSON.parse(event.content).obs) },
)
```

En Node 20 hay que darle a `nostr-tools` un `WebSocket` (paquete `ws`, con `useWebSocketImplementation` de `nostr-tools/pool`); Node 22 y los navegadores ya lo traen.

## Lo que conviene saber

- **Consultas por zona:** no hay rango geográfico arbitrario. Se piden las celdas geohash que cubren el área (`g=9ewmq,9ewmr` por HTTP, `'#g'` por WebSocket) y se recorta en el cliente.
- **Validación:** el relay de referencia rechaza un `content` que no cumpla el esquema de su kind (EVT-7). Los esquemas JSON están en [`packages/schemas`](../../packages/schemas). Los valores de `values` son números, booleanos o textos de hasta 256 caracteres, como mucho 64 campos (EVT-9); fotos y binarios no van en eventos.
- **Agrupar lecturas:** una fuente que mide más de una vez por minuto DEBERÍA juntar varias lecturas en un solo evento, hasta 500 o 64 KB (DATA-9), no publicar una por lectura. El relay limita la tasa por llave (`rate-limited:`).
- **Confianza:** cualquiera puede publicar, así que quien lee decide en quién confiar. Lo publicado por una llave sin rol aparece como `community`; para `verified` hace falta que un ancla de confianza de la ciudad atestigüe su rol en un evento `roles` (kind 31484). Ver [`04`](../spec/04-identidad-y-confianza.md).
- **Privacidad:** nada de datos personales en claro. Para una fuente en un domicilio particular, publica la ubicación redondeada a 3 decimales, unos 110 m (PRIV-9). Ver [`08`](../spec/08-seguridad-y-privacidad.md).
- **Varios relays:** publica en varios, en 3 cuando haya 3 (REPL-1), para que la caída de uno no pierda nada. Cualquier relay Nostr que acepte estos kinds sirve; la API HTTP (`/v1/events`) es propia del relay de referencia, en los demás se usa WebSocket.
- **Historia larga:** los relays guardan una ventana reciente; el historial completo está en los snapshots diarios de cada ciudad (kind 1482, [`06`](../spec/06-distribucion-y-persistencia.md)). Cómo leerlos: [Leer el historial desde los snapshots](historial.md).
- **SDK:** [`@smartcity/sdk`](../../packages/sdk) hace todo esto por ti (tags `c` y `g`, validación antes de firmar, reintentos, cola sin conexión), pero no es necesario.
