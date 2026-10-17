# archiver

CLI de snapshots. Especificación: [`docs/spec/06-distribucion-y-persistencia.md`](../../docs/spec/06-distribucion-y-persistencia.md).

Estado (fase 4): arma el archivo diario, sus adendas y el evento `snapshot` sin firmar de cada uno (SNAP-1, SNAP-2, SNAP-3, SNAP-5), y el `.torrent` de cada archivo con sus web seeds, con `magnet` y `urls` ya en el evento (DIST-1 a DIST-3, parte BitTorrent). Pendientes según `09-roadmap.md`: firma y publicación del evento, subir el archivo a los web seeds, IPFS (`cid`) y el sello OpenTimestamps con `--verify` (SNAP-7).

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
- Escribe `sc_<city>_<día>.ndjson.gz`, su `sc_<city>_<día>.ndjson.gz.torrent` y `sc_<city>_<día>.snapshot.json`, el evento kind 1482 por firmar con `x`, `file`, `count`, `from`, `to`, `relays`, `magnet` y, con `--web-seed`, `urls`. Nunca sobrescribe un archivo que ya existe (SNAP-2).

Sale con código 0 si escribió los archivos, aunque algún relay no se haya podido leer; los relays omitidos quedan en el log.

### Torrent (DIST-1 a DIST-3)

- BitTorrent v1 de un solo archivo, sin dependencias. No lleva fecha de creación ni autor, así que dos archivistas con el mismo archivo, trackers y web seeds producen el mismo `.torrent`; el *info hash* depende solo del archivo y su nombre.
- `--web-seed <base>` (repetible): base HTTP(S) donde se publicará el archivo. La URL de cada archivo (`<base>/<nombre>`) va al torrent como web seed (BEP-19), al magnet como `ws=` y al evento como `urls`. El archivista sube el archivo ahí después; mientras viva algún espejo el torrent tiene fuente.
- `--tracker <url>` (repetible) reemplaza los trackers por defecto (`DEFAULT_TRACKERS` en `src/torrent.ts`: tres UDP públicos y uno `wss:` para WebTorrent). Sin ninguno el torrent funciona por DHT y web seeds.
- Para sembrar, abre el `.torrent` en cualquier cliente BitTorrent con el `.ndjson.gz` en la misma carpeta.

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

## Desarrollo

```sh
pnpm --filter archiver build
pnpm --filter archiver test
```
