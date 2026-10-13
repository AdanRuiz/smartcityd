# 01 · Arquitectura

## Vista general

```
   PRODUCTORES                    RED DE RELAYS                   CONSUMIDORES
 ┌──────────────┐            ┌────────────────────┐           ┌────────────────┐
 │ Sensor ESP32 │──firma──┐  │ Relay A (CF Worker)│  ┌────────│ App web React  │
 │ Gateway IoT  │         ├─►│ Relay B (Rasp. Pi) │◄─┤        │ (IndexedDB)    │
 │ App de 3ros  │─────────┤  │ Relay C (VPS/univ.)│  ├────────│ App de 3ros    │
 │ Ciudadano    │─────────┘  └─────────┬──────────┘  └────────│ Script / IA    │
 └──────────────┘        WebSocket/HTTP│  ▲ arranque                └────────────────┘
                                       ▼  │ desde snapshot
                              ┌───────────┴────────┐
                              │ Archivistas        │  snapshot diario NDJSON
                              │ (cualquiera)       │──► BitTorrent + IPFS
                              └─────────┬──────────┘
                                        ▼
                              OpenTimestamps → Bitcoin (sello de fecha, gratis)
```

Tres planos independientes:

| Plano | Qué es | Vive en |
|---|---|---|
| **Caliente** | Eventos recientes, consultas y suscripciones en vivo | Relays |
| **Frío** | Historial completo e inmutable | Snapshots en torrent/IPFS |
| **Local** | Copia de lo que le interesa a cada usuario, cola de salida | IndexedDB del navegador |

Si el plano caliente cae entero, el frío y el local permiten reconstruirlo.

## Componentes

### 1. Protocolo (eventos firmados)
Formato de mensaje y reglas de validación. Es lo único que todos comparten. Definido en `03`. Compatible con Nostr NIP-01, lo que permite reutilizar librerías, relays y herramientas existentes.

### 2. Relays
Servidores tontos: validan firma y esquema, almacenan, responden filtros y empujan suscripciones. No se coordinan entre sí por obligación; la redundancia la logra el cliente publicando en varios. Ver `07`.

- ARCH-1: Cualquier relay Nostr estándar (strfry, nostr-rs-relay…) DEBE servir como relay del sistema sin modificaciones, aunque no valide esquemas.
- ARCH-2: El relay de referencia añade validación de esquemas, API HTTP y exportación de snapshots.

### 3. SDK (`@smartcity/sdk`)
Librería TypeScript para navegador, Node y Workers. Encapsula firma, validación, pool de relays, caché local, cola offline y evaluación de confianza. Ver `05`.

### 4. App web
SPA React estática. Mapa, capas por dataset, series históricas, envío de reportes, panel de relays y de confianza. No tiene backend propio: habla solo con relays mediante el SDK. Ver `06` para su distribución.

### 5. Archivista
Proceso (CLI de Node, ejecutable en una laptop o en GitHub Actions) que cada día descarga los eventos de una ciudad, genera el snapshot, lo sella y lo publica. Ver `06`.

### 6. Gateway IoT (opcional)
Worker que recibe lecturas por HTTP simple de dispositivos que no pueden firmar y las publica firmadas con la llave del gateway. Ver `05`.

## Flujos principales

**Publicar una observación**
1. La fuente construye el evento, lo valida contra el esquema y lo firma.
2. Lo envía a N relays (por defecto 3) en paralelo.
3. Se considera publicado con ≥1 `OK`; el SDK reintenta los fallidos en segundo plano.

**Consultar el mapa**
1. La app pinta al instante lo que hay en IndexedDB.
2. Abre suscripciones (`REQ`) a varios relays filtrando por ciudad, dataset y geohash del viewport.
3. Deduplica por `id`, verifica firma, clasifica por nivel de confianza y guarda en local.

**Consultar historial largo**
1. La app busca eventos de snapshot (kind 1482) del rango pedido.
2. Descarga los archivos por gateway IPFS o WebTorrent, verifica el hash y los agrega en el cliente.

**Arrancar un relay nuevo**
1. Descarga los snapshots por torrent, importa verificando firmas.
2. Sincroniza el hueco entre el último snapshot y ahora contra otros relays.
3. Publica su URL para que los clientes lo descubran.

## Stack

| Capa | Tecnología | Nota |
|---|---|---|
| App | React + Vite + TypeScript | Build estático, `base: './'`, `HashRouter` |
| Mapa | MapLibre GL + PMTiles (Protomaps) | Las teselas de la ciudad son un solo archivo distribuible por torrent/IPFS; sin servidor de mapas |
| Protocolo | `nostr-tools` | Firma Schnorr secp256k1, pool de relays |
| Almacén local | IndexedDB (`idb`) | Caché + cola de salida |
| Offline | Service Worker (Workbox) | No disponible en `file://`; la app DEBE degradar sin él |
| Relay de referencia | Cloudflare Workers + Durable Objects + D1 | WebSocket con hibernación |
| Espejos de la app | Cloudflare Pages, Vercel, Netlify, GitHub Pages | Todos sirven el mismo build |
| Distribución | IPFS (CID) + BitTorrent/WebTorrent (magnet) | App y snapshots |
| Sello de tiempo | OpenTimestamps | Ancla en Bitcoin sin costo |
| Validación | JSON Schema (Ajv) | Compartida entre SDK y relay |

## Estructura del repositorio

```
/
├─ apps/
│  └─ web/                 # SPA React
├─ packages/
│  ├─ schemas/             # kinds, tags, JSON Schemas, tipos TS generados
│  └─ sdk/                 # @smartcity/sdk
├─ services/
│  ├─ relay-worker/        # relay de referencia (Cloudflare)
│  ├─ gateway-worker/      # gateway IoT opcional
│  └─ archiver/            # CLI de snapshots
├─ docs/spec/              # esta especificación
├─ AGENTS.md
└─ llms.txt
```

Monorepo con pnpm workspaces. `packages/schemas` no depende de nada; todo lo demás depende de él.

## Qué tan descentralizado es cada pieza

| Pieza | Si desaparece… | Mitigación |
|---|---|---|
| Un relay | Los clientes usan los demás | Publicar en ≥3, lista de relays en eventos |
| Cloudflare entero | Caen los relays de referencia | Relays en otro software/infra; snapshots |
| Vercel/Netlify/Pages | Cae un espejo de la app | Otros espejos, IPFS, torrent, copia local |
| Gateways IPFS públicos | No se resuelve el CID por HTTP | Torrent; nodo IPFS local |
| Trackers de torrent | Más difícil hallar peers | DHT; varios trackers en el magnet |
| Bitcoin/OpenTimestamps | No se pueden crear sellos nuevos | Los datos siguen válidos por firma; solo se pierde la prueba de fecha |
| El equipo fundador | Nada técnico | La spec y el código son abiertos; las llaves de autoridad son de cada ciudad |
