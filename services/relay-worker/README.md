# relay-worker

Relay de referencia sobre Cloudflare Workers + Durable Objects + D1. Especificación: [`docs/spec/07-relay-referencia.md`](../../docs/spec/07-relay-referencia.md).

Estado (fase 1): WebSocket NIP-01 con hibernación, aceptación de eventos (pasos 1–7 y la parte de ciudades del 9), reemplazo de direccionables (DATA-3), borrado kind 5 (DATA-8), efímeros sin almacenar, expiración NIP-40, `POST`/`GET /v1/events`, NIP-11 y `/health`.

Pendiente según `09-roadmap.md`: prueba de trabajo y `WRITE_POLICY=roles` (fase 3); `GET /v1/export`, retención e importación de snapshots (fase 4; hasta entonces el relay **no purga**, RELAY-4); `MIRROR_FROM` (fase 5); adjuntos en R2 (opcional).

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

## Despliegue

```sh
npx wrangler d1 create smartcity-relay        # copia el database_id en wrangler.toml
pnpm --filter relay-worker deploy             # aplica migraciones remotas y despliega
```

Sin dominio propio queda en `https://smartcity-relay.<cuenta>.workers.dev`. La configuración está en `[vars]` de `wrangler.toml` (tabla en `07`, "Configuración").

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
- **Pruebas:** `@cloudflare/vitest-pool-workers` exige vitest 4 y el monorepo usa vitest 5. Por eso la lógica se prueba en Node con `node:sqlite` en lugar de D1, y el comportamiento real (hub, WebSocket, D1 local) con `scripts/acceptance.mjs`.
