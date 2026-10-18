# archiver

CLI de snapshots. Especificación: [`docs/spec/06-distribucion-y-persistencia.md`](../../docs/spec/06-distribucion-y-persistencia.md).

Estado (fase 4): arma el archivo diario, sus adendas y el evento `snapshot` sin firmar de cada uno (SNAP-1, SNAP-2, SNAP-3, SNAP-5), el `.torrent` de cada archivo con sus web seeds y su CID de IPFS, con `cid`, `magnet` y `urls` ya en el evento (DIST-1 a DIST-3), firma y publica ese evento con la llave del archivista (DIST-2) sella su `id` en los calendarios de OpenTimestamps y completa la prueba cuando confirma la transacción (pasos 1 y 3 de "Sello de tiempo"). Pendientes según `09-roadmap.md`: subir el archivo a los web seeds, fijarlo en IPFS, publicar la prueba como kind 1040 (NIP-03) y verificarla contra Bitcoin con `--verify` (SNAP-7).

Corre en la máquina del archivista o en CI, no en un Worker. Depende solo de `@smartcity/schemas`, `nostr-tools` y Node. Agregar una dependencia externa cambia `pnpm-lock.yaml`, y eso lo hace una persona, no el agente (`docs/operacion/agente.md`).

## `archiver snapshot`

```sh
node dist/cli.js snapshot --city mx-gdl --day 2026-10-09 \
  --relay wss://relay-a.example --relay wss://relay-b.example --out snapshots/ \
  --web-seed https://github.com/<org>/<repo>/releases/download/sc-mx-gdl-2026-10-09
```

- Rechaza un día que no haya salido del periodo de gracia de 48 h (SNAP-1).
- Lee el día de cada relay con `GET /v1/export?c=&day=` siguiendo el `cursor`, y une por `id` (SNAP-5, DATA-6). Un relay que falla se reporta y se omite; si ninguno responde no escribe nada.
- Verifica `id` y `sig` de cada evento y el esquema de los kinds del sistema; deja fuera, y lo reporta, lo que no sea de la ciudad, del día o de un kind archivable (regulares y direccionables) y todo evento con `expiration` (NIP-40), salvo los kind 5 (SNAP-16).
- Omite los eventos con un kind 5 válido de su autor que conozca cualquiera de los relays (`GET /v1/events?kinds=5&since=`), por `e` y por `a` (SNAP-3, DATA-8). No aplica otra política de exclusión: `policy` es `"none"`.
- Escribe `sc_<city>_<día>.ndjson.gz`, su `sc_<city>_<día>.ndjson.gz.torrent` y `sc_<city>_<día>.snapshot.json`, el evento kind 1482 por firmar con `x`, `file`, `count`, `from`, `to`, `relays`, `cid`, `magnet` y, con `--web-seed`, `urls`. Nunca sobrescribe un archivo que ya existe (SNAP-2).

Sale con código 0 si escribió los archivos, aunque algún relay no se haya podido leer; los relays omitidos quedan en el log.

### Torrent (DIST-1 a DIST-3)

- BitTorrent v1 de un solo archivo, sin dependencias. No lleva fecha de creación ni autor, así que dos archivistas con el mismo archivo, trackers y web seeds producen el mismo `.torrent`; el *info hash* depende solo del archivo y su nombre.
- `--web-seed <base>` (repetible): base HTTP(S) donde se publicará el archivo. La URL de cada archivo (`<base>/<nombre>`) va al torrent como web seed (BEP-19), al magnet como `ws=` y al evento como `urls`. El archivista sube el archivo ahí después; mientras viva algún espejo el torrent tiene fuente.
- `--tracker <url>` (repetible) reemplaza los trackers por defecto (`DEFAULT_TRACKERS` en `src/torrent.ts`: tres UDP públicos y uno `wss:` para WebTorrent). Sin ninguno el torrent funciona por DHT y web seeds.
- Para sembrar, abre el `.torrent` en cualquier cliente BitTorrent con el `.ndjson.gz` en la misma carpeta.

### IPFS (DIST-1, ADR-15)

- El `cid` se calcula sin nodo ni dependencias (`src/ipfs.ts`) y es el que da `ipfs add --cid-version=1` con los valores por defecto de kubo: bloques de 256 KiB como hojas `raw`, árbol UnixFS balanceado de hasta 174 enlaces por nodo y sha2-256. Un archivo de un solo bloque es un CID `raw` (`bafkrei…`); uno mayor, `dag-pb` (`bafybei…`).
- El archivista no sube nada a IPFS: para fijar el archivo, `ipfs add --cid-version=1 <archivo>` en su nodo (o en el de cualquier voluntario) devuelve el mismo `cid` del evento. Con otras opciones (`--chunker`, `--raw-leaves=false`, CIDv0) el CID cambia.

## `archiver addendum`

```sh
node dist/cli.js addendum --city mx-gdl --day 2026-10-09 \
  --relay wss://relay-a.example --relay wss://relay-b.example --out snapshots/
```

Para un día cuyo archivo diario ya está en `--out` (SNAP-2):

- Comprueba cada archivo publicado del día (el diario y las adendas `_a1`, `_a2`…) contra el `x` y el `file.x` de su `.snapshot.json`; si no coinciden, se detiene.
- Vuelve a leer los relays como `snapshot`, con las mismas verificaciones y borrados, y aplica también los kind 5 que ya están archivados aunque ningún relay los sirva hoy (SNAP-3).
- Escribe `sc_<city>_<día>_a<N>.ndjson.gz`, su `.torrent` y `sc_<city>_<día>_a<N>.snapshot.json` (tag `["t", "addendum"]` y los mismos `from` y `to` que el diario, para que el relay sume su `count`, RELAY-4) solo con los eventos que ningún archivo del día tiene. Sin eventos nuevos no escribe nada.

Todavía no usa el cursor de recepción (SNAP-8): vuelve a pedir el día completo.

## `archiver publish`

```sh
node dist/cli.js publish snapshots/sc_mx-gdl_2026-10-09.snapshot.json \
  --relay wss://relay-a.example --relay wss://relay-b.example --key archivista.ncryptsec
```

O en el mismo paso que genera el archivo: `archiver snapshot … --publish --key archivista.ncryptsec` (y lo mismo con `addendum`), que publica en los mismos `--relay` de los que leyó.

- La llave es la propia del archivista (ID-4), cifrada con NIP-49; se genera con `node packages/sdk/scripts/city.mjs keygen --out archivista.ncryptsec`. La frase se pide sin eco o se toma de `SC_PASSPHRASE`. Para que los relays purguen los días archivados (RELAY-4), esa llave necesita el rol `archiver` en la lista `roles` de la ciudad.
- Antes de firmar comprueba el `.ndjson.gz` contra el `x` y el `file.x` del evento (SNAP-6); si no coinciden, no firma.
- Firma una sola vez: guarda `sc_<city>_<día>[_a<N>].snapshot.signed.json` y, en ejecuciones siguientes, reenvía ese mismo evento sin pedir la llave. Volver a firmar daría otro `id`, y el sello OTS y los relays que ya lo tienen se refieren al primero.
- Envía el evento a todos los relays a la vez con `POST /v1/events`. Un relay que lo rechaza o no responde se reporta; sale con código 1 solo si ninguno lo aceptó, y se puede repetir más tarde.

## `archiver stamp`

```sh
node dist/cli.js stamp snapshots/sc_mx-gdl_2026-10-09.snapshot.signed.json
```

- Sella el `id` del evento `snapshot` ya firmado; como el `id` compromete a `x`, la prueba cubre todos los eventos del archivo (docs/spec/06, "Sello de tiempo").
- Como el cliente de referencia (`ots stamp`), añade un nonce aleatorio y hace SHA-256 antes de enviar, así los calendarios no ven el `id`. Envía ese digest a todos los calendarios a la vez (`POST /digest`) y une sus respuestas en un solo `sc_<city>_<día>[_a<N>].snapshot.ots`, el formato `.ots` estándar con SHA-256 del `id` como digest del archivo (NIP-03). Sin dependencias: el formato está en `src/ots.ts`.
- `--calendar <url>` (repetible) reemplaza los calendarios por defecto (`DEFAULT_CALENDARS` en `src/stamp.ts`: los cuatro del cliente de referencia, de tres operadores). Un calendario que falla o responde algo que no es una prueba válida se reporta; sale con código 1 solo si ninguno respondió, y no escribe nada.
- La prueba queda pendiente hasta que la transacción del calendario confirme (horas). Nunca sobrescribe un `.ots` que ya existe; volver a correrlo solo lo reporta.

Todavía no publica la prueba como kind 1040. Para completarla, `archiver upgrade`.

## `archiver upgrade`

```sh
node dist/cli.js upgrade snapshots/sc_mx-gdl_2026-10-09.snapshot.ots
```

- Completa una prueba pendiente cuando la transacción del calendario confirma (docs/spec/06, "Sello de tiempo", paso 3), como `ots upgrade`: por cada atestación pendiente pide `GET <calendario>/timestamp/<compromiso>` y une la respuesta en ese nodo. Las atestaciones pendientes se conservan, así un calendario que aún no confirma puede completar su parte en otra corrida.
- Solo consulta los calendarios permitidos: los de `--calendar` o, sin él, `DEFAULT_CALENDARS`. La URI de la atestación viene del archivo y no se sigue si no está en esa lista.
- Un calendario que responde 404 aún no confirma; uno que falla o responde algo que no es una prueba se reporta y no cambia nada. Reemplaza el `.ots` (a través de un archivo temporal) solo si algo se agregó.
- Reporta los bloques de Bitcoin que la prueba atestigua, o que sigue pendiente. Sale con código 0 en ambos casos; se repite más tarde (horas) hasta que aparezca un bloque.
- No comprueba que el bloque contenga el compromiso: eso es la verificación (`--verify`, SNAP-7), pendiente.

## Desarrollo

```sh
pnpm --filter archiver build
pnpm --filter archiver test
```
