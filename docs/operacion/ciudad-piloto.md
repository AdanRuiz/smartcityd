# Puesta en marcha de la ciudad piloto (Guadalajara, `mx-gdl`)

Guía operativa, no normativa: aplica `docs/spec/04` (TRUST-1, TRUST-4, TRUST-11, TRUST-12) y `03` (kinds `city`, `roles`, `dataset`). Cierra el punto 3 de `docs/revision-pendiente.md` cuando se completa.

## Qué ya está listo y qué falta

| Pieza | Estado |
|---|---|
| Relays | Dos de referencia: `wss://smartcity-relay.adan0001.workers.dev`, `wss://smartcity-relay-b.adan0001.workers.dev`. Falta uno fuera de Cloudflare (`services/relay-strfry`). |
| Mapa base | Extracto OSM en `https://smartcity-tiles.adan0001.workers.dev/mx-gdl/20261015.pmtiles`, sha256 `07e25b6c699f49adf668a51b93ebb9d9c4bf1ed5d0ba70c7d0984667e5254939` (`services/tiles-worker`). |
| Herramienta | `packages/sdk/scripts/city.mjs`: llaves, borradores, firma sin conexión, verificación de la mayoría y publicación. |
| **Custodios** | **Sin designar.** Es una decisión de personas e instituciones, no técnica (Q-10). |

## 1. Designar custodios (TRUST-11)

- Al menos **tres**, en organizaciones distintas (por ejemplo: una universidad, una organización civil, una dependencia municipal). Ninguna debe poder actuar sola: la rotación exige mayoría estricta (TRUST-12).
- Al menos **una llave guardada fuera de línea** y que no dependa de quién ocupe un cargo (por ejemplo, en una caja de seguridad de la institución).
- Cada custodio publica su `npub` por un canal propio y verificable fuera del sistema (sitio oficial, gaceta, oficio firmado): es lo que los usuarios compararán en la página «Confianza» de la app (TRUST-8).

## 2. Ceremonia de llaves (cada custodio, en su equipo)

Preferible en una máquina sin red. Se necesita Node 20+ y este repositorio con `pnpm install && pnpm --filter @smartcity/sdk build` hecho antes de desconectarla.

```sh
cd packages/sdk
node scripts/city.mjs keygen --out custodio-<org>.ncryptsec
```

Pide una frase de 12+ caracteres y guarda la llave **cifrada** (NIP-49). Imprime `npub` y hex. Guarda dos copias del archivo en medios distintos; sin la frase no sirve, y sin el archivo no hay recuperación (`04`, «Pérdida o robo de llave»).

## 3. Borrador de la definición `city` (uno, el mismo para todos)

Una persona lo genera con las `npub` de todos y lo reparte; cada custodio comprueba que su `npub` está bien antes de firmar.

```sh
node scripts/city.mjs draft-city city.draft.json --id mx-gdl --name Guadalajara \
  --bbox 20.55,-103.47,20.78,-103.24 --tz America/Mexico_City \
  --relays wss://smartcity-relay.adan0001.workers.dev,wss://smartcity-relay-b.adan0001.workers.dev \
  --roots npub1…,npub1…,npub1… \
  --tiles-x 07e25b6c699f49adf668a51b93ebb9d9c4bf1ed5d0ba70c7d0984667e5254939 \
  --tiles-url https://smartcity-tiles.adan0001.workers.dev/mx-gdl/20261015.pmtiles
```

El borrador guarda el `content` exacto como texto: TRUST-12 exige que todas las raíces firmen el **mismo contenido byte a byte**. No se edita a mano después de repartirlo.

## 4. Firmar (cada custodio) y verificar

```sh
node scripts/city.mjs sign city.draft.json --key custodio-<org>.ncryptsec --out city.<org>.json
node scripts/city.mjs verify city.*.json
```

`verify` comprueba firma y esquema de cada archivo, que el contenido sea idéntico y cuántas raíces firmaron. Con 3 raíces basta que firmen 2 para la mayoría estricta, aunque conviene que firmen todas.

## 5. Roles y dataset oficial

Lista de roles (la firma al menos una raíz; los clientes la aceptan de cualquier ancla, TRUST-4):

```sh
node scripts/city.mjs draft-roles roles.draft.json --id mx-gdl \
  --entry npub1…:authority:"Gobierno municipal" \
  --entry npub1…:operator:"Organismo de agua" \
  --entry npub1…:moderator:"Equipo de moderación"
node scripts/city.mjs sign roles.draft.json --key custodio-<org>.ncryptsec --out roles.<org>.json
```

Dataset de calidad del aire (caso de uso 1), firmado por la llave con rol `authority` que lo mantendrá:

```sh
node scripts/city.mjs draft-dataset aire.draft.json --id mx-gdl
node scripts/city.mjs sign aire.draft.json --key autoridad.ncryptsec --out aire.json
```

## 6. Publicar

Esta parte sí necesita red. Los archivos firmados no contienen secretos y pueden copiarse a cualquier equipo conectado.

```sh
node scripts/city.mjs publish city.*.json roles.*.json aire.json
```

## 7. Embeber las raíces en la app (TRUST-1)

En `apps/web/src/config.ts`, `roots` de `mx-gdl` con los hex de las raíces, y `dataset` con la dirección `31481:<pubkey de la autoridad>:air-quality`. Con eso, un build nuevo resuelve la ciudad sola y deja de mostrar «sin anclas». Los relays de referencia pueden recibir las mismas raíces en `TRUST_ANCHORS` (`services/relay-worker/wrangler.toml`) para no pedir prueba de trabajo a las llaves con rol.

## Después

- Cambiar raíces: nueva definición firmada por la mayoría de las raíces vigentes (TRUST-12); el cliente la acepta sola en la fase 5, antes se muestra como propuesta.
- Revocar una llave con rol: nueva lista `roles` sin ella o con `blocked`.
