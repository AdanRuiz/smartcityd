# 05 · Integración de apps y dispositivos

Hay tres formas de conectarse, de más cómoda a más básica. Todas producen lo mismo: eventos firmados según `03`.

| Vía | Para quién | Requiere |
|---|---|---|
| SDK `@smartcity/sdk` | Apps web, Node, Workers | npm |
| WebSocket Nostr (NIP-01) | Cualquier lenguaje con librería Nostr | Librería de firma Schnorr |
| HTTP del relay de referencia | Scripts, `curl`, microcontroladores, agentes de IA | Solo HTTP |

Para "conectar una app" no hay alta ni aprobación: se genera una llave y se publica. Publicar la ficha `app` (kind 31483) es opcional y sirve para aparecer en el directorio y poder recibir el rol `app`.

## 1. SDK

API objetivo (TypeScript). Los nombres son normativos para la v1 del SDK.

```ts
import { createClient, localSigner, nip07Signer } from '@smartcity/sdk'

const sc = await createClient({
  city: 'mx-gdl',
  relays: ['wss://relay-a.example', 'wss://relay-b.example'], // opcional: por defecto la lista semilla + los de la ciudad
  signer: nip07Signer(),            // opcional: sin firmante el cliente es de solo lectura
  trustAnchors: ['<pubkey>', …],    // opcional: por defecto las raíces de la ciudad
  storage: 'indexeddb',             // 'indexeddb' | 'memory'
})

// --- Catálogo
const datasets = await sc.datasets.list()
const aq = await sc.datasets.get('31481:9f3c…:air-quality')

// --- Publicar
await sc.datasets.define({ d: 'ruido', name: 'Ruido ambiental', license: 'CC0-1.0',
  mode: 'observation', geometry: 'point', fields: { laeq: { type: 'number', unit: 'dB' } } })

await sc.sources.register({ d: 'balcon-01', dataset: aq.address, name: 'Balcón', loc: [20.6668, -103.3918] })

const res = await sc.observations.publish({
  dataset: aq.address,
  source: '31482:<mi pubkey>:balcon-01',
  loc: [20.6668, -103.3918],
  obs: [{ ts: 1760000000, values: { pm25: 18.2 } }],
})
// res = { id, accepted: ['wss://…'], rejected: [{ relay, reason }], queued: boolean }

await sc.reports.create({ category: 'bache', title: 'Bache profundo', loc: [20.67, -103.39], photos: [file] })
await sc.reports.update(reportId, { status: 'resolved', body: 'Reparado' })
await sc.state.set({ d: 'parking-centro', dataset, values: { free: 42, total: 120 }, loc })
sc.live.emit({ d: 'bus-142', dataset, values: { route: '380', speed: 31 }, loc })

// --- Leer
const rows = await sc.observations.query({ dataset: aq.address, bbox, since, until, trust: 'verified' })
const unsub = sc.observations.subscribe({ dataset: aq.address, bbox }, (obs) => { … })
const reports = await sc.reports.query({ category: 'bache', bbox, status: 'open' })

// --- Historial desde snapshots
for await (const ev of sc.archive.read({ from: '2026-01-01', to: '2026-06-30', kinds: [1480] })) { … }

// --- Bajo nivel
await sc.publish(unsignedEvent)       // valida, firma, envía
sc.subscribe(filters, onEvent)        // filtros NIP-01 crudos
sc.trustOf(event)                     // 'verified' | 'community' | 'flagged'
```

### Comportamiento obligatorio del SDK

| ID | Regla |
|---|---|
| SDK-1 | Valida contra el esquema antes de firmar; si falla, lanza error y no envía. |
| SDK-2 | Añade automáticamente los tags `c` y los tres `g` a partir de `city` y `loc`. |
| SDK-3 | Publica en paralelo a todos los relays de escritura; resuelve al primer `OK` y sigue reintentando el resto con retroceso exponencial. |
| SDK-4 | Sin conexión o sin ningún `OK`: guarda el evento ya firmado en la cola de salida local y devuelve `queued: true`. Reenvía al reconectar. |
| SDK-5 | Verifica `id` y `sig` de todo evento recibido, deduplica y descarta los que no cumplan esquema. La verificación corre en un Web Worker en navegador. |
| SDK-6 | Traduce `bbox` al conjunto mínimo de celdas geohash (precisión 4–6) y recorta el resultado exacto en el cliente. |
| SDK-7 | Agrupa lecturas: `observations.buffer({ maxItems, maxSeconds })` acumula y publica un solo evento (DATA-9). |
| SDK-8 | Resuelve prueba de trabajo cuando un relay la exige (SPAM-1), en un Web Worker cuando corre en navegador. |
| SDK-9 | No depende de APIs de Node ni del DOM en su núcleo; funciona en navegador, Node ≥ 20 y Workers. |
| SDK-10 | Expone el estado de cada relay (conectado, latencia, último error) para que la UI lo muestre. |
| SDK-11 | En navegador, la primera vez que guarda una llave o encola un evento llama a `navigator.storage.persist()` y expone el resultado (`sc.storage.persisted`). Es una petición que el navegador puede negar: la app no debe asumir que se concedió (ID-7). |
| SDK-12 | Si un relay rechaza un evento de la cola por antigüedad (RELAY-5), el SDK lo vuelve a firmar con `created_at` actual y reintenta. El momento real del hecho no se pierde porque va en el contenido (`ts`). Para poder hacerlo, una llave desechable (PRIV-5) se conserva hasta que su evento tenga al menos un `OK`. |

## 2. WebSocket (NIP-01)

Cualquier cliente Nostr funciona. Mensajes:

```
cliente → relay   ["EVENT", <evento>]
                  ["REQ", "<sub id>", <filtro>, …]
                  ["CLOSE", "<sub id>"]
relay → cliente   ["OK", "<event id>", true|false, "<prefijo>: <mensaje>"]
                  ["EVENT", "<sub id>", <evento>]
                  ["EOSE", "<sub id>"]          // fin de lo almacenado; sigue lo nuevo en vivo
                  ["CLOSED", "<sub id>", "<mensaje>"]
```

Prefijos de rechazo que el cliente DEBE entender: `invalid:` (firma, esquema o fecha), `duplicate:`, `rate-limited:`, `pow:`, `blocked:`, `restricted:`.

## 3. HTTP (relay de referencia)

Pensado para lo que no puede o no quiere mantener un WebSocket. Detalle en `07`.

```bash
# Publicar un evento ya firmado
curl -X POST https://relay.example/v1/events \
  -H 'content-type: application/json' -d @evento.json
# → 200 {"ok":true,"id":"…"}   |   400 {"ok":false,"reason":"invalid: …"}

# Consultar (mismos campos que un filtro NIP-01, tags como parámetros)
curl 'https://relay.example/v1/events?kinds=1480&c=mx-gdl&g=9ewmq&since=1759996400&limit=500'
# → application/x-ndjson, un evento por línea

# Información del relay (NIP-11)
curl -H 'accept: application/nostr+json' https://relay.example/
```

## Gateway IoT (opcional)

Para dispositivos que no pueden firmar (Arduino de 8 bits, equipos comerciales con webhook).

```
dispositivo ──HTTP + token──► gateway (Worker) ──evento firmado──► relays
```

```http
POST /v1/ingest/<source d>
Authorization: Bearer <token del dispositivo>
Content-Type: application/json

{ "ts": 1760000000, "values": { "pm25": 18.2 } }
```

| ID | Regla |
|---|---|
| GW-1 | El gateway firma con **su** llave. La confianza recae en el operador del gateway, no en el dispositivo. |
| GW-2 | El dueño de la fuente lista la pubkey del gateway en `keys` de su `source`. |
| GW-3 | El gateway agrupa lecturas por fuente y publica como máximo un evento por fuente por minuto. |
| GW-4 | Si falta `ts`, usa la hora de recepción. |
| GW-5 | Los tokens y secretos se guardan como secretos del Worker; nunca se publican en eventos. |
| GW-6 | El gateway es una conveniencia centralizada: quien pueda firmar en el dispositivo DEBERÍA evitarlo. |
| GW-7 | El token `Bearer` solo se admite sobre TLS. Un dispositivo que no pueda usar TLS (microcontroladores de 8 bits) DEBE autenticarse con HMAC, descrito abajo. |
| GW-8 | El gateway rechaza una petición HMAC cuyo contador no sea mayor que el último aceptado de ese dispositivo. |

#### Autenticación HMAC (dispositivos sin TLS)

Sin TLS un token viaja en claro: quien escuche la red lo copia y publica lecturas falsas. Con HMAC el secreto nunca sale del dispositivo.

```http
POST /v1/ingest/<source d>
X-SC-Counter: 48211
X-SC-Signature: <hex de HMAC-SHA256(secreto, "<source d>\n<contador>\n<cuerpo>")>
Content-Type: application/json

{ "ts": 1760000000, "values": { "pm25": 18.2 } }
```

- `X-SC-Counter` es un entero que solo crece. Puede ser la hora Unix si el dispositivo tiene reloj, o un contador guardado en memoria no volátil si no lo tiene.
- El contador evita que una petición capturada se reenvíe; la firma evita que se altere.
- Alcance: protege el tramo dispositivo → gateway. **No** protege si el propio gateway es vulnerado, porque el gateway conoce los secretos y tiene la llave que firma. Ese riesgo solo se elimina firmando en el dispositivo (GW-6).
- Las lecturas viajan sin cifrar; son datos destinados a ser públicos.

## Dispositivos que firman

Un ESP32 puede firmar Schnorr secp256k1 en decenas de milisegundos. Flujo recomendado:

1. Generar la llave en el dispositivo en el primer arranque; mostrar la pubkey por serial o QR.
2. El dueño la añade a `keys` de su `source` desde la app.
3. El dispositivo acumula lecturas y hace `POST /v1/events` cada N minutos a 2–3 relays.
4. Necesita reloj: sincronizar por NTP antes de firmar (DATA-4).

## Agentes de IA y scripts

- Lectura sin llave por HTTP: `GET /v1/events` devuelve NDJSON listo para procesar.
- Para análisis de periodos largos, usar snapshots (`06`) en lugar de paginar relays.
- Un agente que publique DEBE usar una llave propia y una ficha `app` que declare que es automatizado (`"automated": true` en el contenido).
