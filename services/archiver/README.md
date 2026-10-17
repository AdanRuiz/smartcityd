# archiver

CLI de snapshots. Especificación: [`docs/spec/06-distribucion-y-persistencia.md`](../../docs/spec/06-distribucion-y-persistencia.md).

Estado (fase 4): arma el archivo diario y el evento `snapshot` sin firmar (SNAP-1, SNAP-3, SNAP-5). Pendientes según `09-roadmap.md`: firma y publicación del evento, adendas (SNAP-2), IPFS y torrent con web seeds (DIST-1 a DIST-3) y el sello OpenTimestamps con `--verify` (SNAP-7).

Corre en la máquina del archivista o en CI, no en un Worker. Depende solo de `@smartcity/schemas`, `nostr-tools` y Node. Agregar una dependencia externa cambia `pnpm-lock.yaml`, y eso lo hace una persona, no el agente (`docs/operacion/agente.md`).

## `archiver snapshot`

```sh
node dist/cli.js snapshot --city mx-gdl --day 2026-10-09 \
  --relay wss://relay-a.example --relay wss://relay-b.example --out snapshots/
```

- Rechaza un día que no haya salido del periodo de gracia de 48 h (SNAP-1).
- Lee el día de cada relay con `GET /v1/export?c=&day=` siguiendo el `cursor`, y une por `id` (SNAP-5, DATA-6). Un relay que falla se reporta y se omite; si ninguno responde no escribe nada.
- Verifica `id` y `sig` de cada evento y el esquema de los kinds del sistema; deja fuera, y lo reporta, lo que no sea de la ciudad, del día o de un kind archivable (regulares y direccionables) y lo vencido por NIP-40.
- Omite los eventos con un kind 5 válido de su autor que conozca cualquiera de los relays (`GET /v1/events?kinds=5&since=`), por `e` y por `a` (SNAP-3, DATA-8). No aplica otra política de exclusión: `policy` es `"none"`.
- Escribe `sc_<city>_<día>.ndjson.gz` y `sc_<city>_<día>.snapshot.json`, el evento kind 1482 por firmar con `x`, `file`, `count`, `from`, `to` y `relays`.

Sale con código 1 si algún relay no se pudo leer, aunque haya escrito los archivos.

## Desarrollo

```sh
pnpm --filter archiver build
pnpm --filter archiver test
```
