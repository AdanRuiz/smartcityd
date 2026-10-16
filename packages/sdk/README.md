# @smartcity/sdk

Cliente del protocolo SmartCity para navegador, Node ≥ 20 y Workers. Especificación: [`docs/spec/05-integracion-de-apps.md`](../../docs/spec/05-integracion-de-apps.md).

Estado (fase 3): cliente, firmantes local y NIP-07, pool de relays con estado, validación al publicar y al recibir, publicación y consulta de `dataset`, `source` y `observation`, agrupación de lecturas; almacén local y cola de salida (IndexedDB o memoria), reportes y `report_update` con llave desechable, niveles de confianza (`sc.trustOf`, roles, moderación) y prueba de trabajo.

Pendiente según `09-roadmap.md`: fotos en reportes (adjuntos, PRIV-4, SEC-4); refirmado de la cola por antigüedad (SDK-12) y `sc.archive.read` (fase 4); `state` y `live` (fase 5); rotación de raíces por mayoría (TRUST-12).

```ts
import { createClient, localSigner, generateSecretKey } from '@smartcity/sdk'

const sc = await createClient({
  city: 'mx-gdl',
  relays: ['wss://relay-a.example', 'wss://relay-b.example'],
  trustAnchors: ['<pubkey raíz>'],          // resuelve la definición `city` y añade sus relays
  signer: localSigner(generateSecretKey()), // sin firmante: solo lectura; se cambia con sc.setSigner()
})

const { address } = await sc.datasets.define({ d: 'air-quality', name: 'Calidad del aire', license: 'CC0-1.0',
  mode: 'observation', geometry: 'point', categories: ['ambiente'],
  fields: { pm25: { type: 'number', unit: 'ug/m3', min: 0, max: 1000 } } })

await sc.observations.publish({ dataset: address, loc: [20.6668, -103.3918], obs: [{ ts: 1760000000, values: { pm25: 18.2 } }] })

const rows = await sc.observations.query({ dataset: address, bbox: [20.6, -103.45, 20.7, -103.35] })
const close = sc.observations.subscribe({ dataset: address }, (reading) => console.log(reading))
sc.relays.onChange((status) => console.table(status))

// Reportes: llave nueva por reporte (PRIV-5), ubicación a 4 decimales (PRIV-3), prueba de trabajo (SPAM-1)
const { id } = await sc.reports.create({ category: 'bache', title: 'Bache profundo', loc: [20.67, -103.39] })
await sc.reports.update(id, { status: 'resolved', body: 'Reparado' }) // solo cuenta si la llave es authority u operator
const abiertos = await sc.reports.query({ category: 'bache', status: 'open', trust: ['verified', 'community'] })
sc.trustOf(event) // 'verified' | 'community' | 'flagged'
```

En navegador, con almacén y cola que sobreviven a recargas: `createClient({ ..., storage: 'indexeddb' })`.

## Qué hace por su cuenta

| Regla | Comportamiento |
|---|---|
| SDK-1 | `sc.publish` valida contra el esquema de `packages/schemas` antes de firmar y lanza `ValidationError` sin enviar nada. `observations.publish` además revisa `values` contra los `fields` del dataset si lo encuentra (EVT-8). |
| SDK-2 | Añade `c` con la ciudad del cliente y los tres `g` de `content.loc` si faltan. Redondea coordenadas a 6 decimales en los métodos de alto nivel. |
| SDK-3, REPL-1 | Publica en todos los relays de escritura en paralelo, resuelve al primer `OK` (o cuando todos respondieron sin aceptar) y reintenta en segundo plano los fallos transitorios (conexión, tiempo agotado, `rate-limited:`) con retroceso exponencial, hasta 6 intentos. `invalid:`, `blocked:`, `restricted:` y `pow:` son definitivos para ese evento (`pow:` se resuelve minando otro, SDK-8). |
| SDK-5, DATA-1, DATA-4, DATA-6, EVT-7 | Todo lo recibido pasa por estructura, fecha (≤ 15 min en el futuro), esquema e `id` + `sig`; se deduplica por `id`. En navegador la verificación va en un Web Worker con `workerVerifier` (abajo). |
| SDK-6 | `bbox` → celdas geohash a la precisión más fina (6, 5 o 4) que quepa en 48 celdas por filtro; el resultado se recorta exacto. |
| SDK-7 | `sc.observations.buffer(target, { maxItems, maxSeconds })` junta lecturas y publica un solo evento. |
| SDK-9 | El núcleo compila con `lib: ES2022` y sin tipos de DOM ni de Node. En Node 20, que no trae `WebSocket` global, pasar `WebSocket` del paquete `ws`. |
| SDK-10 | `sc.relays.status()` y `sc.relays.onChange()`: estado, latencia del último `OK`/`EOSE` y último error de cada relay. Las conexiones se abren al primer uso; `sc.relays.connect()` las abre todas ya. |
| REPL-2 | Las consultas preguntan a todos los relays de lectura y unen; los direccionables se reducen al ganador por DATA-3. |
| REPL-4, REPL-6 | Escribe solo en los relays que se le dan (lista semilla) y en los `relays` de la definición `city` de las anclas. No añade relays públicos por su cuenta. |
| TRUST-1, TRUST-3 | Con `trustAnchors` toma la definición `city` firmada por ellas. Sin anclas no elige: `sc.city` queda en `null` y `sc.cityCandidates()` lista las existentes. |
| SDK-4, GOAL-7, NFR-3 | Sin ningún `OK` y sin un rechazo definitivo de todos los relays, el evento firmado queda en la cola (`queued: true`) y se reenvía cuando un relay conecta, cada 30 s mientras haya algo, o con `sc.outbox.flush()`. Lo que se publica y lo que llega se guarda en el almacén local, y las consultas lo unen a lo de los relays: sin red se sigue viendo. `sc.outbox.list()`, `onChange()` y `rejected()`. |
| SDK-8, SPAM-1 | Antes de firmar un `report` de una llave sin rol mina 16 bits (NIP-13); si un relay pide más (`pow: difficulty N required`), mina otra vez y reenvía. En navegador, en un Web Worker con `workerMiner`; se cancela con `signal`. |
| SDK-11, ID-7 | La primera vez que encola, pide `navigator.storage.persist()`; `sc.storage.persisted` dice si se concedió. |
| TRUST-4, TRUST-7, TRUST-10 | Solo cuentan las listas `roles` firmadas por las anclas; las anclas cuentan como `authority`. `sc.trustOf(evento)` y `sc.trust.levelOf(lectura)` calculan `verified` (rol, o llave listada en `keys` de una fuente cuyo dueño tiene rol), `flagged` (llave `blocked`, o etiqueta 1985 / denuncia 1984 de un `moderator`) o `community`. Nunca se toma del evento; `sc.trust.setAnchors()` lo recalcula y avisa por `sc.trust.onChange()`. |
| TRUST-5 | `observations.query` y `reports.query` aceptan `trust` con los niveles que se quieren. |
| `03`, PRIV-3, PRIV-5 | `reports.create` firma por defecto con una llave nueva (sin firmante en el cliente basta) y redondea `loc` a 4 decimales. El estado de un reporte es el del `report_update` oficial más reciente (autor `authority` u `operator`); los demás son comentarios. |
| ID-2, SEC-3 | `localSigner` guarda la llave dentro del cierre y no la expone. `encryptSecretKey`/`decryptSecretKey` cifran con NIP-49 para guardarla. |

## Verificación y minado en Web Workers (navegador)

```ts
import { createClient, workerMiner, workerVerifier } from '@smartcity/sdk'
import PowWorker from '@smartcity/sdk/pow-worker?worker&inline' // Vite
import VerifyWorker from '@smartcity/sdk/verify-worker?worker&inline'

const sc = await createClient({
  city: 'mx-gdl',
  storage: 'indexeddb',
  verifier: workerVerifier(new VerifyWorker()),
  miner: workerMiner(new PowWorker()),
})
```

## Desarrollo

```sh
pnpm --filter @smartcity/sdk test        # sobre un relay falso en memoria
pnpm --filter @smartcity/sdk e2e wss://relay-a,wss://relay-b   # NFR-1 contra relays reales (requiere build)
```

`sensor` (`node scripts/sensor.mjs <dirección del dataset> [relays] --every 10`) simula un sensor que publica una lectura cada N segundos e imprime la hora de cada envío, para medir NFR-1 contra la app abierta en otra máquina.

`e2e` publica un dataset `sdk-e2e` y observaciones con una llave desechable y mide cuánto tarda cada una en llegar a otro cliente suscrito. Contra `smartcity-relay.adan0001.workers.dev` (un relay, 2026-10-16): 15/15 recibidas, p50 138 ms, p95 246 ms. Contra los dos relays de referencia (`smartcity-relay` y `smartcity-relay-b`, 2026-10-16): 20/20 recibidas, p50 84 ms, p95 225 ms, y cada relay guardó las 20.
