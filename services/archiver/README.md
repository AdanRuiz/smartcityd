# archiver

CLI de snapshots. Especificación: [`docs/spec/06-distribucion-y-persistencia.md`](../../docs/spec/06-snapshots.md).

Estado: esqueleto del paquete (fase 4). Arma el archivo diario, el evento `snapshot`, la publicación en IPFS y torrent y el sello OpenTimestamps (SNAP-1 a 8), pendientes según `09-roadmap.md`.

Corre en la máquina del archivista o en CI, no en un Worker. Depende solo de `@smartcity/schemas`, `nostr-tools` y Node. Agregar una dependencia externa cambia `pnpm-lock.yaml`, y eso lo hace una persona, no el agente (`docs/operacion/agente.md`).

## Desarrollo

```sh
pnpm --filter archiver build
pnpm --filter archiver test
```
