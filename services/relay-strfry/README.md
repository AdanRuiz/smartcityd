# relay-strfry

Relay Nostr **estándar** ([strfry](https://github.com/hoytech/strfry)) con la política de escritura de SmartCity, para operar un relay fuera de Cloudflare en un VPS, una Raspberry Pi o cualquier máquina con Docker. Es el entregable «un relay Nostr estándar, fuera de Cloudflare» de `docs/spec/11` (ARCH-1, invariante 1: ningún proveedor es obligatorio).

strfry guarda y sirve cualquier evento como un relay normal: estructura NIP-01, `id`, firma, tamaño (64 KB) y duplicados los comprueba él mismo. El plugin `src/policy.ts` añade las reglas de `07` que no necesitan base de datos, con los mismos prefijos que el relay de referencia:

| Paso de `07` | Regla | Prefijo |
|---|---|---|
| 2 | Solo los kinds de `03` y los NIP reutilizados | `blocked:` |
| 3 | `created_at` ≤ ahora + 15 min; regulares no más antiguos que `MAX_EVENT_AGE_DAYS` (RELAY-5) | `invalid:` |
| 7 | Esquema del `content` y tags obligatorios (`packages/schemas`) | `invalid:` |
| 8 | `report` con `POW_BITS_REPORT` bits de NIP-13 | `pow:` |
| 9 | Ciudades de `CITIES` | `restricted:` |

Diferencia con el relay de referencia: el plugin no lee las listas `roles`, así que pide la prueba de trabajo a **todo** `report`, también a llaves con rol (el SDK la mina cuando un relay la pide, SPAM-1). No hay `WRITE_POLICY=roles` ni API HTTP `/v1/*`: la app y el SDK solo usan WebSocket.

## Poner en marcha

Requisitos: Docker con Compose, un dominio cuyo DNS apunte a la máquina y los puertos 80 y 443 abiertos (Caddy obtiene el certificado TLS solo).

```sh
pnpm install && pnpm --filter relay-strfry build      # dist/policy.mjs
cd services/relay-strfry
RELAY_DOMAIN=relay.ejemplo.org docker compose up -d --build
```

El relay queda en `wss://relay.ejemplo.org`. Variables opcionales: `CITIES` (por defecto `*`), `POW_BITS_REPORT` (16), `MAX_EVENT_AGE_DAYS` (30). Los datos viven en el volumen `strfry-db`.

Sin dominio (solo pruebas en la misma máquina): `docker compose up -d strfry` y `ws://127.0.0.1:7777`.

Después, añadir la URL a la lista semilla (`packages/sdk/src/client.ts`, `apps/web/src/config.ts`) y a `relays` de la definición `city` (`docs/operacion/ciudad-piloto.md`).

## Copiar lo que ya tienen los otros relays

Para traer los eventos de la ciudad desde un relay de referencia (`download` los escribe en la salida; `import` verifica sus firmas y los guarda):

```sh
docker compose exec strfry sh -c '/app/strfry --config=/etc/strfry.conf download wss://smartcity-relay.adan0001.workers.dev   --filter "{\"#c\":[\"mx-gdl\"],\"limit\":1000}" | /app/strfry --config=/etc/strfry.conf import'
```

El relay de referencia sobre Workers no implementa negentropy; `download` usa un `REQ` normal. El espejo continuo entre relays (`MIRROR_FROM`, REPL-3) es de la fase 5.

## Comprobado

En Docker local (2026-10-16): `e2e` del SDK contra `ws://127.0.0.1:7777`, 20/20 lecturas recibidas (p50 101 ms); un reporte minado se acepta, un kind 1 se rechaza con `blocked:`, un reporte sin minar recibe `pow: difficulty 16 required` y el SDK lo vuelve a minar y lo publica. Copia desde `smartcity-relay`: 706 eventos de `mx-gdl` importados. Tests de la política: `pnpm --filter relay-strfry test`.
