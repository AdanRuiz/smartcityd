# 07 · Relay de referencia (Cloudflare Workers)

Implementación en `services/relay-worker`. Es **una** forma de operar un relay; cualquier relay Nostr estándar también sirve (ARCH-1). Se eligió Workers porque su capa gratuita permite WebSockets y base de datos sin tarjeta de crédito.

## Arquitectura

```
                    ┌────────────────────────── Worker ───────────────────────────┐
 WebSocket  ───────►│ fetch(): Upgrade → Durable Object "hub"                     │
 HTTP /v1/* ───────►│ fetch(): valida → D1 → notifica al hub                      │
 Cron       ───────►│ scheduled(): retención, caducados                            │
                    └──────────┬──────────────────────────────┬──────────────────┘
                               ▼                              ▼
                    Durable Object "hub"                    D1 (SQLite)
                    · sockets con hibernación               · events
                    · suscripciones activas                 · tags
                    · fan-out de eventos nuevos
                                                            R2 (opcional): adjuntos
```

- El **hub** mantiene los WebSockets usando la API de hibernación, de modo que las conexiones inactivas no consumen tiempo de cómputo.
- **D1** es el almacén. Las rutas HTTP lo consultan directo, sin pasar por el hub.
- v1 usa un solo hub. Partir por ciudad (`/c/<city>` → un hub por ciudad) queda fuera de la v1 salvo que la medición de la fase 1 muestre que un hub no sostiene la carga del piloto; es un cambio interno que no toca el protocolo. Ver `10`, Q-5.

## Esquema D1

```sql
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  pubkey      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  kind        INTEGER NOT NULL,
  d           TEXT,                 -- solo direccionables
  city        TEXT,                 -- valor del tag c (o d si kind = 31480)
  tags        TEXT NOT NULL,        -- JSON
  content     TEXT NOT NULL,
  sig         TEXT NOT NULL,
  expires_at  INTEGER,
  received_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX events_kind_time   ON events (kind, created_at DESC);
CREATE INDEX events_city_time   ON events (city, created_at);
CREATE INDEX events_city_recv   ON events (city, received_at, id);
CREATE UNIQUE INDEX events_addr ON events (kind, pubkey, d) WHERE d IS NOT NULL;

CREATE TABLE tags (
  name        TEXT NOT NULL,        -- una letra
  value       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  kind        INTEGER NOT NULL,
  event_id    TEXT NOT NULL,
  PRIMARY KEY (name, value, created_at, event_id)
) WITHOUT ROWID;
```

Solo se indexan en `tags` los nombres `a`, `e`, `g`, `p`, `t`, `x`. El tag `c` va como columna (`city`) para ahorrar escrituras.

## Aceptación de un evento

En este orden; el primer fallo responde `["OK", id, false, "<prefijo>: …"]`:

| # | Comprobación | Prefijo |
|---|---|---|
| 1 | Tamaño ≤ 64 KB, estructura NIP-01 | `invalid:` |
| 2 | Kind permitido (los de `03` + 5, 1040, 1984, 1985, 10002) | `blocked:` |
| 3 | `created_at` ≤ ahora + 15 min; y, si es regular, no más antiguo que `MAX_EVENT_AGE_DAYS` | `invalid:` (antigüedad: `invalid: too old`) |
| 4 | Límite de tasa por IP y por pubkey | `rate-limited:` |
| 5 | `id` correcto y firma válida | `invalid:` |
| 6 | Ya existe | `duplicate:` (con `true`) |
| 7 | Esquema del `content` y tags obligatorios | `invalid:` |
| 8 | Prueba de trabajo si aplica | `pow:` |
| 9 | Política del operador (ciudades, llaves) | `restricted:` |

Después:

- **Regular**: `INSERT` en `events` y `tags`.
- **Direccionable**: si existe uno con el mismo `(kind, pubkey, d)` y gana el nuevo según DATA-3, se reemplaza (borrando sus filas de `tags`); si no, se descarta respondiendo `duplicate:`.
- **Efímero**: no se guarda.
- **Kind 5**: borra los eventos referidos cuyo `pubkey` coincida con el del solicitante; guarda el propio kind 5.
- En todos los casos aceptados se entrega a las suscripciones cuyo filtro coincida.

| ID | Regla |
|---|---|
| RELAY-1 | La verificación de firma ocurre antes de cualquier escritura. |
| RELAY-2 | Inserción de evento y sus tags en una sola operación `batch` de D1. |
| RELAY-3 | Los límites de tasa van antes de la verificación de firma para no gastar CPU en abuso. |
| RELAY-5 | El límite de antigüedad aplica solo a eventos regulares que llegan de clientes. No aplica a la importación de snapshots ni al espejo desde otros relays (`MIRROR_FROM`), que por definición traen eventos antiguos. El valor se declara en el documento NIP-11. |

El límite de antigüedad acota dos cosas: cuánto puede antedatarse un evento y cuánto tiempo después de un día pueden aparecer adendas de ese día (`06`).

## Suscripciones

- `REQ` → consulta D1 con cada filtro, envía resultados ordenados por `created_at` descendente (respetando `limit`, tope 1000), luego `EOSE`, y registra la suscripción.
- Máximo 10 suscripciones por socket y 10 filtros por suscripción.
- Las suscripciones se persisten en el almacenamiento del Durable Object, no en el adjunto del socket (cuyo tamaño es muy limitado), para sobrevivir a la hibernación.
- El fan-out evalúa los filtros en memoria contra cada evento nuevo.

Traducción de filtro a SQL: `ids`, `authors`, `kinds`, `since`, `until` sobre `events`; cada `#x` como `EXISTS` sobre `tags`, salvo `#c` que usa la columna `city`. Se elige como tabla conductora la condición más selectiva (por lo general un tag `a` o `g`).

## API HTTP

| Método y ruta | Descripción |
|---|---|
| `GET /` + `Upgrade: websocket` | Protocolo Nostr |
| `GET /` + `Accept: application/nostr+json` | Documento NIP-11: nombre, operador, NIPs soportados, límites, política, retención |
| `POST /v1/events` | Publica un evento firmado. `200 {ok:true,id}` o `400 {ok:false,reason}` |
| `GET /v1/events` | Consulta. Parámetros: `ids`, `authors`, `kinds`, `since`, `until`, `limit`, y una letra por tag (`c`, `a`, `g`, `e`, `p`, `t`). Valores múltiples separados por coma. Respuesta NDJSON |
| `GET /v1/export?c=<city>&day=<YYYY-MM-DD>` | NDJSON canónico del día (formato de `06`), para archivistas. Paginado con `cursor`. Excluye los eventos con `expiration`, vencidos o no (SNAP-16) |
| `GET /v1/export?c=<city>&received_after=<cursor>` | Eventos en el orden en que el relay los recibió, a partir de un cursor opaco. La última línea es `{"cursor":"…"}` para continuar. Permite al archivista traer solo lo nuevo, incluidos los eventos tardíos, sin recorrer días anteriores |
| `PUT /v1/blob` / `GET /v1/blob/<sha256>` | Opcional. Adjuntos en R2, direccionados por hash; requiere evento de autorización firmado |
| `GET /health` | `200` con contadores básicos |

Todas las respuestas llevan `Access-Control-Allow-Origin: *`: la app corre desde orígenes arbitrarios, incluido `null` (`file://`).

## Retención

Tarea programada (Cron Trigger) diaria:

- borra eventos con `expires_at` vencido; un borrado (kind 5) nunca caduca, aunque lleve `expiration` (SNAP-16);
- borra regulares más antiguos que `RETENTION_DAYS` (por defecto 90) **solo si** ese día está archivado y el archivo es obtenible (RELAY-4); los que llevan `expiration` se borran junto con su día archivado aunque no hayan vencido: ningún snapshot los contiene (SNAP-16), pero el autor los marcó como temporales, y así una caducidad lejana no retiene espacio indefinidamente;
- nunca borra direccionables vigentes ni kinds 5, 1040, 1482.

RELAY-4: Un relay no elimina por antigüedad datos que no estén archivados. Un día cuenta como archivado cuando se cumplen las tres condiciones:

1. existe un evento `snapshot` que lo cubre, firmado por una llave con rol `archiver` según `TRUST_ANCHORS`;
2. el relay comprobó que el archivo se puede obtener: al menos una de sus `urls` o web seeds responde y el tamaño coincide con `file.size`;
3. el `count` del snapshot (sumando sus adendas) es mayor o igual al número de eventos que el relay tiene de ese día, sin contar los que llevan `expiration` (SNAP-16). Si es menor, al relay le quedan eventos que el archivista no vio, y no purga.

Sin `TRUST_ANCHORS` configuradas ningún día cuenta como archivado: el relay no purga por antigüedad y solo borra los eventos vencidos (NIP-40), y deja en el log el motivo (ADR-20). Un anuncio de snapshot sin archivo descargable no autoriza a borrar nada. Si el almacenamiento se llena antes de poder purgar, el relay rechaza escrituras nuevas (`restricted: storage full`) en lugar de borrar datos sin archivar.

## Configuración

Variables de `wrangler.toml`:

| Variable | Por defecto | Descripción |
|---|---|---|
| `RELAY_NAME`, `RELAY_CONTACT` | — | Para NIP-11 |
| `CITIES` | `*` | Ciudades aceptadas, separadas por coma |
| `WRITE_POLICY` | `open` | `open` \| `roles` (solo llaves con rol de un ancla) |
| `TRUST_ANCHORS` | — | Pubkeys ancla, para `roles`, para exigir PoW solo a desconocidos y para reconocer archivistas; sin anclas no hay purga por antigüedad (RELAY-4) |
| `POW_BITS_REPORT` | `16` | Dificultad para `report` de llaves sin rol; `0` desactiva |
| `RATE_EVENTS_PER_MIN` | `60` | Por pubkey |
| `RETENTION_DAYS` | `90` | Solo tiene efecto con `TRUST_ANCHORS` (RELAY-4); `0` desactiva la purga por antigüedad |
| `MAX_EVENT_AGE_DAYS` | `30` | Antigüedad máxima de eventos regulares de clientes (RELAY-5); `0` desactiva |
| `MIRROR_FROM` | — | Relays de los que este espeja (suscripción saliente desde el cron) |

Despliegue: `pnpm --filter relay-worker deploy` tras crear la base D1 y aplicar migraciones. Sin dominio propio queda en `*.workers.dev`.

## Capacidad en capa gratuita

Cifras orientativas; **verificar en la documentación de Cloudflare antes de dimensionar**, cambian a menudo.

| Recurso | Límite gratuito aproximado | Qué restringe |
|---|---|---|
| Peticiones al Worker | ~100 000 / día | Publicaciones HTTP + consultas + conexiones |
| CPU por petición | ~10 ms | Verificación de firma: medir en la fase 1 |
| D1 filas escritas | ~100 000 / día | Cada evento escribe su fila, sus tags y sus índices |
| D1 filas leídas | ~5 000 000 / día | Consultas mal indexadas lo agotan rápido |
| D1 almacenamiento | ~5 GB | Con retención de 90 días |

Estimación: una observación típica cuesta del orden de 10–15 filas escritas contando índices, así que un relay gratuito admite del orden de **10⁴ eventos por día**. Con agrupación (DATA-9) eso son millones de lecturas diarias; sin ella, apenas unas decenas de sensores. De ahí que agrupar y repartir entre varios relays sea parte del diseño y no una optimización.

Mediciones obligatorias para cerrar la fase 1: costo de CPU de la verificación Schnorr en Workers, y costo real de filas por evento. Qué se hace si la verificación no cabe ya está decidido (`10`, ADR-14).

## Pruebas de aceptación

1. Evento válido por WebSocket → `OK true`; un segundo cliente suscrito lo recibe en < 1 s.
2. Mismo evento otra vez → `OK true` con `duplicate:`; sin fila nueva.
3. Firma alterada, esquema inválido, fecha futura, kind ajeno → `OK false` con el prefijo correcto.
4. Direccionable más nuevo reemplaza; más viejo se descarta.
5. Kind 5 del autor borra; de otra llave no.
6. `GET /v1/events` y `REQ` con el mismo filtro devuelven el mismo conjunto.
7. `GET /v1/export` de un día produce un NDJSON cuyo sha256 coincide con el que calcula el archivista.
8. El socket sobrevive a la hibernación y sigue recibiendo eventos de su suscripción.
9. Un cliente Nostr genérico (por ejemplo `nak`) publica y consulta sin adaptaciones.
10. Un evento regular más antiguo que el máximo se rechaza por WebSocket y HTTP, y se acepta por importación de snapshot.
11. `received_after` devuelve un evento tardío (con `created_at` de hace 10 días) sin tener que pedir ese día.
12. La purga no borra un día cuyo snapshot no es descargable o cuyo `count` es menor que lo almacenado.
