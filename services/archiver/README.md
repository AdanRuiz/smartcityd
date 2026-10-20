# archiver

CLI de snapshots. Especificación: [`docs/spec/06-distribucion-y-persistencia.md`](../../docs/spec/06-distribucion-y-persistencia.md).

Estado (fase 4): arma el archivo diario, sus adendas y el evento `snapshot` sin firmar de cada uno (SNAP-1, SNAP-2, SNAP-3, SNAP-5), con las adendas de los eventos tardíos que cada relay recibió desde la última corrida, sin volver a pedir días archivados (`archiver late`, SNAP-8), el consolidado mensual que une los diarios y adendas de un mes cuando ya no pueden recibir adendas (`archiver monthly`, SNAP-4, SNAP-9), el `.torrent` de cada archivo con sus web seeds y su CID de IPFS, con `cid`, `magnet` y `urls` ya en el evento (DIST-1 a DIST-3), firma y publica ese evento con la llave del archivista (DIST-2) sella su `id` en los calendarios de OpenTimestamps, completa la prueba cuando confirma la transacción y la publica como kind 1040 (NIP-03) en los relays ("Sello de tiempo"); con `--verify` comprueba la prueba contra los encabezados de bloque de Bitcoin (SNAP-7). También calcula el CID de IPFS y el torrent de un build de la app para su evento `release` (`archiver app`, DIST-1, DIST-3). Pendientes según `09-roadmap.md`: subir el archivo a los web seeds y fijarlo en IPFS.

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

Vuelve a pedir el día completo; para no recorrer días ya archivados, `archiver late`.

## `archiver late`

```sh
node dist/cli.js late --city mx-gdl \
  --relay wss://relay-a.example --relay wss://relay-b.example --out snapshots/
```

Halla los eventos tardíos sin volver a pedir días ya archivados (SNAP-8):

- Pide a cada relay solo lo que recibió desde su cursor (`GET /v1/export?c=&received_after=`, `docs/spec/07`) y sigue las páginas hasta que el cursor deja de avanzar. Guarda el cursor de cada relay en `sc_<city>.cursors.json` dentro de `--out`; un relay sin cursor guardado empieza desde `0`, todo lo que tiene.
- Los eventos de un día cuyo diario está en `--out` van a una adenda nueva de ese día, igual que con `archiver addendum`: mismas verificaciones, los kind 5 de los relays (desde el inicio del día más antiguo con eventos tardíos) y los ya archivados, y solo lo que ningún archivo del día tiene (SNAP-2, SNAP-3, SNAP-5). Los de días sin diario se dejan para `archiver snapshot`, que lee el día completo, y salen en el log.
- Los cursores se guardan después de escribir las adendas: si la corrida se interrumpe, la siguiente vuelve a pedir desde el mismo punto y los archivos publicados evitan repetir eventos.
- Un relay que no tiene la ruta (responde 400, 404, 405 o 501, como el relay de referencia mientras no se vuelva a desplegar) se lee con la alternativa de SNAP-8: toma el máximo de antigüedad que declara en su documento NIP-11 (`limitation.created_at_lower_limit`, RELAY-5) y pide con `GET /v1/events?c=&since=` todo lo de la ciudad creado en esa ventana, paginando hacia atrás con `until`. Como no tiene cursor, no se guarda ninguno para él y en cada corrida vuelve a leer la ventana entera; los archivos publicados evitan repetir eventos. Un relay sin máximo declarado no tiene ventana acotada y se reporta como fallido (para él, `archiver addendum --day`).
- Un relay que falla se reporta y conserva su cursor; si ninguno responde no escribe nada.
- Con `--publish --key` firma y publica cada adenda escrita, como `snapshot` y `addendum`. Se puede correr en un cron diario.

## `archiver monthly`

```sh
node dist/cli.js monthly --city mx-gdl --month 2026-10 --out snapshots/ \
  --relay wss://relay-a.example --relay wss://relay-b.example \
  --web-seed https://github.com/<org>/<repo>/releases/download/sc-mx-gdl-2026-10
```

El consolidado mensual (SNAP-4): une los diarios y las adendas de un mes que ya están en `--out` en un solo archivo y un solo torrent, para que se siembre uno por mes en vez de uno por día.

- Rechaza un mes cuyo último día aún puede recibir adendas: se genera cuando ese día cumple 30 días, el máximo de antigüedad por defecto de los relays (SNAP-9, RELAY-5). Conviene correr `archiver late` una última vez antes.
- Rechaza un mes al que le falte el diario de algún día, y se detiene si un archivo no coincide con el `x` y el `file.x` de su `.snapshot.json`. Vuelve a verificar `id` y `sig` de cada evento (SNAP-6).
- Omite lo que borra un kind 5 de su autor: los ya archivados en el mes y, con `--relay`, los que conocen los relays desde el inicio del mes (SNAP-3). Sin `--relay` no usa la red.
- Escribe `sc_<city>_<YYYY-MM>.ndjson.gz`, su `.torrent` y `sc_<city>_<YYYY-MM>.snapshot.json`: tag `["t", "monthly"]`, `from` el inicio del mes y `to` el del siguiente, para que el relay compare su `count` con lo que guarda del mes (RELAY-4), y `cid`, `magnet` y `urls` como un diario (DIST-1 a DIST-3). `relays` une los de los archivos del mes y los leídos. Nunca sobrescribe un archivo que ya existe.
- Con `--publish --key` lo firma y publica en los `--relay`, como `snapshot`; después se sella con `stamp`, `upgrade` y `attest`, como cualquier `snapshot`.

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

Para completarla, `archiver upgrade`; para publicarla, `archiver attest`.

## `archiver upgrade`

```sh
node dist/cli.js upgrade snapshots/sc_mx-gdl_2026-10-09.snapshot.ots
```

- Completa una prueba pendiente cuando la transacción del calendario confirma (docs/spec/06, "Sello de tiempo", paso 3), como `ots upgrade`: por cada atestación pendiente pide `GET <calendario>/timestamp/<compromiso>` y une la respuesta en ese nodo. Las atestaciones pendientes se conservan, así un calendario que aún no confirma puede completar su parte en otra corrida.
- Solo consulta los calendarios permitidos: los de `--calendar` o, sin él, `DEFAULT_CALENDARS`. La URI de la atestación viene del archivo y no se sigue si no está en esa lista.
- Un calendario que responde 404 aún no confirma; uno que falla o responde algo que no es una prueba se reporta y no cambia nada. Reemplaza el `.ots` (a través de un archivo temporal) solo si algo se agregó.
- Reporta los bloques de Bitcoin que la prueba atestigua, o que sigue pendiente. Sale con código 0 en ambos casos; se repite más tarde (horas) hasta que aparezca un bloque.
- Sin `--verify` no comprueba que el bloque contenga el compromiso; con `--verify`, después de completarla verifica la prueba contra Bitcoin (ver abajo) y sale con código 1 si no verifica o sigue pendiente.

## `archiver attest`

```sh
node dist/cli.js attest snapshots/sc_mx-gdl_2026-10-09.snapshot.ots \
  --relay wss://relay-a.example --relay wss://relay-b.example --key archivista.ncryptsec
```

- Publica la prueba como evento kind 1040 (NIP-03; docs/spec/06, "Sello de tiempo"): tag `e` con el `id` del snapshot, `k` con `1482`, `c` con su ciudad (para que los relays lo guarden y exporten con ella) y `content` = el `.ots` en base64. Lo firma la llave del archivista, como `publish`.
- NIP-03 exige que la prueba tenga una atestación de Bitcoin, así que una prueba aún pendiente se rechaza sin pedir la llave: primero `archiver upgrade`. Por eso el paso 2 de "Sello de tiempo" (publicar la prueba pendiente) no se hace: se publica una sola vez, ya completa (paso 3).
- Como pide NIP-03, el evento lleva solo la rama hacia el bloque más bajo, sin atestaciones pendientes; el `.ots` local no cambia.
- Comprueba que la prueba selle el `id` del `sc_<city>_<día>[_a<N>].snapshot.signed.json` de al lado y que ese evento sea válido.
- Firma una sola vez: guarda `sc_<city>_<día>[_a<N>].ots.signed.json` y en ejecuciones siguientes reenvía ese mismo evento sin pedir la llave, aunque `upgrade` haya añadido después otro bloque al `.ots`: firmar otro daría dos 1040 distintos del mismo snapshot. Si esa copia no es una prueba firmada válida de este snapshot, se niega; se borra para firmar otra.
- Envía a todos los relays a la vez con `POST /v1/events`; sale con código 1 solo si ninguno lo aceptó.
- Con `--verify`, la rama que va en el evento (la nueva o la ya firmada) debe verificar contra Bitcoin antes de pedir la llave o enviar nada.

## `--verify`: la prueba contra Bitcoin

```sh
node dist/cli.js upgrade snapshots/sc_mx-gdl_2026-10-09.snapshot.ots --verify
node dist/cli.js upgrade snapshots/sc_mx-gdl_2026-10-09.snapshot.ots --verify --esplora http://localhost:3002
```

- Verificación obligatoria de la CLI (SNAP-7), como `ots verify`: por cada atestación de Bitcoin de la prueba, el mensaje al que llegan sus operaciones desde el `id` del snapshot debe ser la raíz de Merkle del bloque de esa altura. Si lo es, el archivo existía antes de ese bloque; reporta su altura y su hora.
- Los encabezados los pide a APIs Esplora (`GET /block-height/<altura>` y `GET /block/<hash>/header`), sin dependencias: por defecto `DEFAULT_ESPLORAS` en `src/verify.ts` (blockstream.info y mempool.space, dos operadores); `--esplora <url>` (repetible) las reemplaza. La única fuente que no exige confianza es una Esplora propia delante de un nodo Bitcoin (electrs); las públicas son una conveniencia.
- Cada encabezado debe tener el hash que la API dio y cumplir la prueba de trabajo de su propio `nBits`, así una API no puede inventar un bloque sin minarlo. Se pregunta a todas: las que responden deben dar el mismo encabezado, y una caída solo resta.
- Falla (código 1) si una atestación apunta a un bloque con otra raíz, si las Esplora no coinciden, si ninguna responde o si la prueba no tiene atestaciones de Bitcoin. Las atestaciones pendientes o desconocidas no cuentan.

## `archiver app`

```sh
pnpm build
node dist/cli.js app ../../apps/web/dist --web-seed https://smartcity-web.pages.dev --web-seed https://<otro espejo> --out .
```

Calcula el `dist` del evento `release` (kind 31486, docs/spec/06) de un build de la app, sin red ni dependencias, para ponerlo en el borrador antes de que lo firme el desarrollador (`city.mjs draft-release --dist-cid … --dist-magnet …`, ver [`packages/sdk`](../../packages/sdk/README.md)). Publica el build en las dos redes de DIST-1:

- **IPFS:** `cid` es el CID del directorio `dist/` entero, el mismo que da `ipfs add -r --cid-version=1 apps/web/dist` con los valores por defecto de kubo (sin los archivos ocultos, como ese comando). Con él la app abre en `https://<gateway>/ipfs/<cid>/` y el archivo único en `…/<cid>/smartcity.html` (APP-2). Fijarlo es `ipfs add -r --cid-version=1` en un nodo propio o de voluntarios (ADR-15).
- **BitTorrent:** el torrent es de `smartcity.html` solo (APP-4), el archivo que quien llega por torrent abre con doble clic ("Canales"). Escribe `smartcity.html.torrent` en `--out` y su magnet lleva como web seeds (`ws=`, DIST-3) `<espejo>/smartcity.html` por cada `--web-seed`: los espejos ya lo sirven, porque está en `dist/`. Un torrent del directorio entero no podría usarlos, porque BEP-19 busca sus archivos en `<espejo>/<nombre del torrent>/`.
- Imprime en stdout `--dist-cid <cid> --dist-magnet '<magnet>'`; en stderr, el sha256 de `smartcity.html`, que debe coincidir con el `x` del `release`. Sale con error si el build no tiene `smartcity.html`.
- `--tracker` funciona como en `snapshot`. El torrent no depende de la fecha, así que otro voluntario con el mismo `smartcity.html` y los mismos web seeds obtiene el mismo magnet y puede sembrarlo.

## Desarrollo

```sh
pnpm --filter archiver build
pnpm --filter archiver test
```
