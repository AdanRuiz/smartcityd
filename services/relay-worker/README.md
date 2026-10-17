# relay-worker

Relay de referencia sobre Cloudflare Workers + Durable Objects + D1. Especificación: [`docs/spec/07-relay-referencia.md`](../../docs/spec/07-relay-referencia.md).

Estado (fase 3): WebSocket NIP-01 con hibernación, aceptación de eventos (pasos 1 a 9 de `07`), prueba de trabajo para `report` de llaves sin rol, `WRITE_POLICY=roles`, reemplazo de direccionables (DATA-3), borrado kind 5 (DATA-8), efímeros sin almacenar, expiración NIP-40, `POST`/`GET /v1/events`, NIP-11 y `/health`. Fase 4: `GET /v1/export?c=<city>&day=<YYYY-MM-DD>`, el NDJSON canónico del día (`06`), y retención diaria por Cron Trigger condicionada a que el día esté archivado (RELAY-4), e importación de snapshots sin contactar a otro relay (NFR-4, RELAY-5, SNAP-6).

Pendiente según `09-roadmap.md`: `GET /v1/export?received_after=` (responde `unsupported:`) y rechazo con `restricted: storage full` (fase 4); `MIRROR_FROM` (fase 5); adjuntos en R2 (opcional).

## Desarrollo

```sh
pnpm --filter relay-worker db:migrate:local   # crea la D1 local
pnpm --filter relay-worker dev                # http://127.0.0.1:8787 y ws://127.0.0.1:8787
pnpm --filter relay-worker test               # lógica de aceptación y consultas sobre node:sqlite
```

Con el relay corriendo:

```sh
pnpm --filter relay-worker acceptance [url]   # pruebas de aceptación 1–6 y 9 de 07, de extremo a extremo
pnpm --filter relay-worker load [url] --events 300 --sensors 30 --readings 60
pnpm --filter relay-worker bench:verify       # costo de verificar id + firma en esta máquina
```

`url` es por defecto `http://127.0.0.1:8787`. La prueba 9 usa `SimplePool` de nostr-tools y, si `nak` está instalado, también `nak`.

## Importar snapshots

Para reconstruir un relay desde los archivos diarios (`06`), sin pedir nada a otro relay (NFR-4):

```sh
pnpm --filter relay-worker snapshot:import \
  --snapshot snapshot-2025-08-30.json --out import.sql sc_mx-gdl_2025-08-30.ndjson.gz [más archivos…]
npx wrangler d1 execute DB --file import.sql --remote   # o --local; --env b para el segundo relay
```

Las rutas son relativas a `services/relay-worker`. Cada `--snapshot` es el evento `snapshot` firmado de uno de los archivos (se empareja por `file.name`); si está, se comprueban su firma, `file.size`, `file.x` y el hash canónico `x` del NDJSON sin comprimir, y un archivo que no coincide no se importa. Sin él solo se avisa, porque cada evento se verifica igual. Las variables de política (`CITIES`, `WRITE_POLICY`, `TRUST_ANCHORS`, `POW_BITS_REPORT`) se leen del entorno, con los mismos nombres que en `wrangler.toml`.

## Despliegue

```sh
npx wrangler d1 create smartcity-relay        # copia el database_id en wrangler.toml
pnpm --filter relay-worker deploy             # aplica migraciones remotas y despliega
```

Sin dominio propio queda en `https://smartcity-relay.<cuenta>.workers.dev`. La configuración está en `[vars]` de `wrangler.toml` (tabla en `07`, "Configuración").

El despliegue de referencia tiene un segundo relay independiente (otro Worker, otro hub y otra base D1) en el entorno `b` de `wrangler.toml`, para que la app y el SDK publiquen y lean en dos (REPL-1):

```sh
pnpm --filter relay-worker deploy:b           # https://smartcity-relay-b.<cuenta>.workers.dev
```

Los dos están en Cloudflare: sirve para cerrar la fase 2, pero un tercero en otro proveedor o en hardware propio sigue pendiente para no depender de uno solo.

## Mediciones para cerrar la fase 1

`09` exige medir en la capa gratuita real el costo de CPU de la verificación de firma y las filas escritas por evento.

1. Despliega y corre `load` contra la URL de `workers.dev`.
2. **Filas por evento:** la salida de `load` (contadores de D1 `rows_written` que suma el hub). Contrástalo con las métricas de D1 en el panel de Cloudflare.
3. **CPU:** en el panel, Workers → `smartcity-relay` → Metrics → CPU time (p50/p99). Para medir la ruta HTTP, que es la que corre en el Worker, usa `POST /v1/events`. Los eventos por WebSocket se aceptan dentro del Durable Object `Hub`, que factura y limita distinto: revisa sus métricas aparte.
4. Si la verificación no cabe en el límite, se sigue el orden de ADR-14 (`10`).

Referencias locales, no sustituyen la medición (Node 24, `wrangler dev`, 2026-10-15):

| Medida | Valor |
|---|---|
| Verificación de id + firma (`bench:verify`) | ~1,3 ms por evento (1 a 60 lecturas); ~1,6 ms con 500 lecturas |
| Filas escritas en D1 local (`load`, observación con 4 tags indexados) | 8 por evento |
| Latencia de `OK` (`load`, 10 conexiones) | p50 ~35 ms, p95 ~41 ms |

En Cloudflare (`smartcity-relay.adan0001.workers.dev`, D1 en WNAM, 2026-10-16), con `load` (200 observaciones de 60 lecturas por WebSocket):

| Medida | Valor |
|---|---|
| Filas escritas en D1 | **8 por evento** (1 fila de evento y 4 de tags, más índices), contra las 10–15 que estima `07` |
| Latencia de `OK` desde el cliente | p50 ~250 ms, p95 ~320 ms |
| CPU por petición, panel de Cloudflare, antes del calentamiento (sobre todo tráfico WebSocket) | p50 0,96 ms · p90 1,95 ms · p99 30,8 ms |
| CPU por petición, panel de Cloudflare, después del calentamiento (con carga por `POST`) | p50 3,8 ms · p90 8,0 ms · p99 19,5 ms · p99,9 24,9 ms |
| CPU de `POST /v1/events` (`wrangler tail`, 90 peticiones, tras el calentamiento) | p50 5 ms · p90 11 ms · máx. 24 ms; 11 de 90 por encima de 10 ms, concentradas al arrancar isolates |
| Peticiones cortadas por CPU | ninguna en ~400 publicaciones, incluida una de 82 ms antes del calentamiento |

El p99 inicial venía de la primera verificación de cada isolate, que construye las tablas de @noble/curves (~20 ms). Ahora se hace al cargar el módulo (`WARM_UP` en `src/accept.ts`), lo que subió el arranque del Worker de 4 a 26 ms y bajó el p90 de `POST` de 28 a 11 ms. En régimen estable una publicación cuesta 2–8 ms (verificación ~1–2 ms; el resto es JSON, hash y esquema). Los picos que quedan son de isolates recién creados (código aún sin optimizar por el JIT).

Para medir la CPU por petición: `wrangler tail smartcity-relay --format json` mientras corre `load --http`; cada invocación trae `cpuTime`.

## Decisiones de implementación

- **Límite de tasa:** `RATE_EVENTS_PER_MIN` por pubkey y 10 veces eso por IP, porque un gateway o una NAT agrupan muchas fuentes. Ventanas de un minuto en memoria: las IP se olvidan al cerrar la ventana (PRIV-8). Por WebSocket el límite vive en el hub; por HTTP, en cada isolate, así que ahí es aproximado.
- **Filtros:** se aceptan `#a #e #g #p #t #x` (tabla `tags`) y `#c #d` (columnas). Un filtro sobre otra letra se rechaza con `unsupported:` en lugar de devolver resultados incompletos. Un filtro admite como máximo 80 valores, porque D1 enlaza como máximo 100 parámetros por consulta.
- **Suscripciones:** se registran antes de la consulta inicial, para no perder lo que llegue mientras tanto; el cliente deduplica (DATA-6).
- **`POST /v1/events`:** responde `{ok:true,id}` y añade `message` cuando el evento ya existía (`duplicate:`).
- **`GET /v1/export` por día:** eventos regulares y direccionables vigentes con `c` igual a la ciudad o a `*` y `created_at` dentro del día UTC, serializados con `canonicalNdjson`/`canonicalLine` de `@smartcity/schemas`, las mismas funciones que usará el archivista, para que el sha256 coincida (prueba 7). Páginas de 1000 eventos: si el día no cabe, la última línea es `{"cursor":"…"}` y la siguiente página se pide con `&cursor=…`; las páginas sin esa línea, concatenadas, son el NDJSON canónico. Un día que cabe en una página no lleva línea de cursor.
- **Retención (`src/retention.ts`):** un Cron Trigger diario (`[triggers]` en `wrangler.toml`, también en el entorno `b`) borra los eventos con `expiration` vencida y, de los días UTC que terminaron hace más de `RETENTION_DAYS`, purga los regulares de una ciudad solo si el día está archivado según las tres condiciones de RELAY-4: un snapshot `daily` o `monthly` de la ciudad que lo cubre, firmado por una llave con rol `archiver` de `TRUST_ANCHORS`; su archivo responde a un `HEAD` en alguna de sus `urls` o web seeds del magnet (`ws=`) con `Content-Length` igual a `file.size`; y su `count`, más el de las adendas obtenibles del mismo archivista y rango, es mayor o igual que los eventos que el relay guarda en ese rango (el mismo conjunto que exporta `GET /v1/export`). Nunca purga direccionables, kinds 5, 1040 ni 1482, ni eventos con `c` igual a `*` o sin ciudad, porque ningún snapshot de una sola ciudad responde por ellos. `RETENTION_DAYS=0` desactiva la purga por antigüedad, y también `TRUST_ANCHORS` vacío (ADR-20): sin anclas cualquiera podría firmar un snapshot falso de un día y hacer borrar sus eventos, así que solo se borran los vencidos y el log del cron lo dice en `ageSkipped`. Cada corrida revisa a lo sumo 20 días (los más antiguos primero) y 40 URLs, para no pasar los límites de subpeticiones y CPU de la capa gratuita; lo demás queda para las corridas siguientes. Los días que no se purgan, con el motivo, salen en el log del cron.
- **Importación de snapshots (`src/import.ts`, `cli/import.ts`):** cada línea pasa por la misma aceptación que un evento de cliente (`acceptEvent` con `origin: 'snapshot'`) salvo el límite de antigüedad (RELAY-5, prueba 10) y el de tasa, que son para clientes: id, firma, esquema, prueba de trabajo y política del operador siguen aplicando. Una línea inválida se descarta y se informa sin invalidar el resto (SNAP-6). No hay ruta HTTP de importación: una ruta abierta permitiría a cualquiera saltarse el límite de antigüedad, y verificar un día de decenas de miles de eventos no cabe en el CPU por petición de la capa gratuita. La CLI importa sobre una copia local en `node:sqlite` (duplicados, DATA-3 y roles entre los archivos) y escribe un archivo SQL con `Store.importStatements`: sentencias que no leen antes de escribir y son idempotentes, así que valen para una base vacía o con datos y se pueden aplicar dos veces. Un direccionable borra las versiones guardadas a las que gana y se ignora si ya hay una que le gana; los kind 5 van al final para borrar también lo de otros archivos. También se importan los propios eventos `snapshot`, que la retención necesita para volver a purgar (RELAY-4). La capa gratuita de D1 limita las filas escritas por día (~8 por evento, ver mediciones): un archivo grande puede necesitar repartirse en varios días.
- **Pruebas:** `@cloudflare/vitest-pool-workers` exige vitest 4 y el monorepo usa vitest 5. Por eso la lógica se prueba en Node con `node:sqlite` en lugar de D1, y el comportamiento real (hub, WebSocket, D1 local) con `scripts/acceptance.mjs`.
