# Leer el historial desde los snapshots

Guía para desarrolladores de fuera del proyecto (GOAL-1), continuación de [Publicar y consumir un dataset propio](primer-dataset.md). Los relays guardan solo una ventana reciente; el historial completo de una ciudad está en sus **snapshots diarios**: archivos NDJSON comprimidos que cualquiera puede descargar, verificar y volver a sembrar (GOAL-2). Esta guía lee un día archivado solo con [`nostr-tools`](https://github.com/nbd-wtf/nostr-tools) y lo que trae el entorno (`fetch`, `crypto.subtle`, `DecompressionStream`). Lo normativo está en [`06`](../spec/06-distribucion-y-persistencia.md#persistencia-de-los-datos-snapshots).

## Cómo se encuentra un día

Cada archivo se anuncia con un evento `snapshot` (kind 1482) firmado por su archivista y publicado en los relays de la ciudad:

| Tag | Valor |
|---|---|
| `c` | La ciudad |
| `t` | `daily` (el día), `addendum` (eventos tardíos del mismo día, SNAP-2), `monthly` (consolidado del mes) |
| `x` | sha256 del NDJSON **sin comprimir**, el hash canónico |

Su `content` dice qué intervalo cubre (`from`, `to`, en segundos Unix), el nombre, el sha256 y el tamaño del `.gz` (`file`), y dónde descargarlo: `urls` HTTP, `cid` de IPFS y `magnet` de BitTorrent. Un día tiene un `daily` y cero o más `addendum`; todos tienen el mismo `from`.

Dentro del archivo hay un evento firmado por línea, los mismos que publicaron sus autores. Por eso la verificación no depende de quién sirve el archivo (SNAP-6): se comprueba el sha256 del `.gz` y el `x` del NDJSON contra el evento `snapshot`, y luego `id` y firma de **cada** línea. Un evento inválido se descarta y no invalida el resto.

## El script completo

Lee un día de Guadalajara: busca sus snapshots en los dos relays de referencia, descarga cada archivo de la primera fuente que lo entregue íntegro, une los eventos por `id`, aplica los borrados que trajeron las adendas y escribe cada lectura con su dataset. Se puede copiar tal cual a un archivo `.mjs` y correr con `node`.

<!-- Este bloque se ejecuta contra el relay de referencia en services/relay-worker/test/guide.test.ts. -->

```js
import { verifyEvent } from 'nostr-tools/pure'

const RELAYS = ['https://smartcity-relay.adan0001.workers.dev', 'https://smartcity-relay-b.adan0001.workers.dev']
const IPFS_GATEWAYS = ['https://ipfs.io', 'https://dweb.link']
const CITY = 'mx-gdl'
const DAY = '2025-10-08'
const KIND = { deletion: 5, observation: 1480, snapshot: 1482, dataset: 31481 }

const start = Date.parse(`${DAY}T00:00:00Z`) / 1000
const sha256 = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')

// 1. Los snapshots del día en todos los relays, con firma válida y uno por hash canónico x.
const snapshots = new Map()
for (const relay of RELAYS) {
  const query = new URLSearchParams({ kinds: String(KIND.snapshot), c: CITY, t: 'daily,addendum', since: String(start) })
  try {
    const res = await fetch(`${relay}/v1/events?${query}`)
    for (const line of (await res.text()).split('\n')) {
      if (!line) continue
      const event = JSON.parse(line)
      if (!verifyEvent(event)) continue
      const content = JSON.parse(event.content)
      if (content.from === start && content.format === 'ndjson+gzip') snapshots.set(content.x, content)
    }
  } catch (error) {
    console.warn(`${relay}: ${error.message}`)
  }
}

// 2. Descarga de la primera fuente que entregue el archivo íntegro: sha256 del .gz y x del NDJSON (SNAP-6).
async function download(content) {
  const sources = [...(content.urls ?? []), ...(content.cid ? IPFS_GATEWAYS.map((g) => `${g}/ipfs/${content.cid}`) : [])]
  for (const url of sources) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const gzip = await res.arrayBuffer()
      if ((await sha256(gzip)) !== content.file.x) continue
      const unzipped = new Blob([gzip]).stream().pipeThrough(new DecompressionStream('gzip'))
      const ndjson = await new Response(unzipped).arrayBuffer()
      if ((await sha256(ndjson)) === content.x) return new TextDecoder().decode(ndjson)
    } catch {
      // Esta fuente falló; se prueba la siguiente.
    }
  }
  return null
}

// 3. Une los archivos por id y verifica cada evento: uno inválido se descarta, el resto sigue valiendo.
const events = new Map()
let invalid = 0
for (const content of snapshots.values()) {
  const ndjson = await download(content)
  if (ndjson === null) {
    console.warn(`${content.file.name}: ninguna fuente lo entregó íntegro`)
    continue
  }
  for (const line of ndjson.split('\n')) {
    if (!line) continue
    try {
      const event = JSON.parse(line)
      if (verifyEvent(event)) events.set(event.id, event)
      else invalid++
    } catch {
      invalid++
    }
  }
}
if (invalid > 0) console.warn(`${invalid} eventos inválidos descartados`)

// 4. Una adenda puede traer el borrado (kind 5) de un evento del diario: solo vale si lo firma su autor.
const deleted = new Set()
for (const event of events.values()) {
  if (event.kind !== KIND.deletion) continue
  for (const [name, id] of event.tags) {
    if (name === 'e' && events.get(id)?.pubkey === event.pubkey) deleted.add(id)
  }
}

// 5. Las lecturas del día en orden, con la dirección de su dataset.
const observations = [...events.values()]
  .filter((event) => event.kind === KIND.observation && !deleted.has(event.id))
  .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
for (const event of observations) {
  const dataset = event.tags.find(([name, value]) => name === 'a' && value.startsWith(`${KIND.dataset}:`))?.[1]
  for (const { ts, values } of JSON.parse(event.content).obs) {
    console.log(new Date(ts * 1000).toISOString(), dataset, values)
  }
}
```

Sale una línea por lectura, por ejemplo `2025-10-08T14:00:00.000Z 31481:3bf0…:air-quality { pm25: 18.2, temp: 24.1 }`.

## Lo que conviene saber

- **En quién confiar:** cualquiera puede publicar un `snapshot`, pero no puede meter en él eventos que nadie firmó: a lo sumo omite algunos. Por eso el script une los archivos de todos los archivistas en vez de elegir uno. Si quieres limitarte a los reconocidos por la ciudad, quédate con los `snapshot` de llaves con rol `archiver` en su evento `roles` (kind 31484, [`04`](../spec/04-identidad-y-confianza.md)), y filtra las lecturas por el autor del dataset, como harías en vivo.
- **Salud de un día:** si varios archivistas independientes publican el mismo `x`, vieron lo mismo. Si hay varios `x`, ninguno está mal: vieron relays distintos, y unir por `id` da el conjunto completo.
- **Sin servidor HTTP:** el `magnet` lleva los mismos `urls` como web seeds, así que cualquier cliente BitTorrent (o WebTorrent en el navegador) baja el archivo aunque solo quede un seeder. El `cid` funciona en cualquier gateway o nodo IPFS propio; los gateways de la lista son una conveniencia, no una dependencia.
- **Meses enteros:** cuando ya no puede llegar nada tarde, el archivista publica un consolidado `monthly` con todos los días del mes; su `from` es el inicio del mes. Para leer muchos días es más barato bajar ese único archivo.
- **Borrados posteriores:** un snapshot es permanente. El archivista omite lo que su autor ya había borrado al generarlo (SNAP-3); un borrado posterior llega en una adenda o en los relays, y quien lee lo aplica como en el paso 4.
- **Reconstruir un relay:** el relay de referencia importa estos mismos archivos con su CLI (`snapshot:import`, ver [`services/relay-worker`](../../services/relay-worker)); un relay vacío vuelve así a tener el historial sin contactar a otro relay (NFR-4).
