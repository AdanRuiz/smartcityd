# SmartCity descentralizado

Especificación de una plataforma de ciudad inteligente sin servidor central: cualquier app o dispositivo puede publicar y leer datos urbanos, y tanto la app como los datos sobreviven aunque desaparezca quien los creó.

Estado: **especificación v1.0 (cerrada el 2026-10-12)**. Sin preguntas abiertas; requisitos priorizados con MoSCoW en [11-priorizacion](docs/spec/11-priorizacion.md). Implementación: fase 0 de [09-roadmap](docs/spec/09-roadmap.md) completa (monorepo y `packages/schemas`); fase 1 completa: relay de referencia en [`services/relay-worker`](services/relay-worker), desplegado y medido en Cloudflare; la verificación de firma en JavaScript cabe (ADR-14, opción 1; mediciones en su README). Fase 2 completa: [`packages/sdk`](packages/sdk) y [`apps/web`](apps/web), dos relays de referencia y espejo en <https://smartcity-web.pages.dev/>; un sensor simulado publica en los dos relays y el punto aparece en el mapa al instante (SDK: p95 225 ms entre publicar y recibir). Fase 3 (offline, reportes y confianza) hecha en código y probada con un relay local: un reporte creado sin conexión se sincroniza al reconectar, una llave `authority` lo marca resuelto y otro cliente ve el estado oficial, y lo de una llave `blocked` queda oculto. Para que los relays desplegados exijan la prueba de trabajo hay que volver a desplegarlos. Ciudad piloto: mapa base de Guadalajara publicado ([`services/tiles-worker`](services/tiles-worker)); herramienta y guía para que los custodios generen llaves sin conexión y firmen `city`, `roles` y el dataset oficial ([`docs/operacion/ciudad-piloto.md`](docs/operacion/ciudad-piloto.md)); relay estándar fuera de Cloudflare listo para desplegar con Docker ([`services/relay-strfry`](services/relay-strfry)). Falta designar a los custodios y una máquina con dominio para el relay strfry. Fase 4 en curso: el relay de referencia exporta el NDJSON canónico de un día (`GET /v1/export?c=&day=`) y purga por antigüedad solo los días archivados en un snapshot descargable y completo (RELAY-4; hay que volver a desplegarlo para que corra el cron), y se reconstruye desde snapshots sin contactar a otro relay: una CLI los verifica e importa sin el límite de antigüedad (NFR-4, RELAY-5, SNAP-6). El archivista ([`services/archiver`](services/archiver)) arma el archivo diario de una ciudad uniendo varios relays, sin lo borrado por su autor y tras las 48 h de gracia, con su evento `snapshot` por firmar (SNAP-1, SNAP-3, SNAP-5), y las adendas con los eventos tardíos de un día ya archivado (SNAP-2); genera el `.torrent` de cada archivo con web seeds y pone `magnet` y `urls` en el evento (DIST-1 a DIST-3); faltan la firma y publicación, subir los archivos a los web seeds, IPFS y el sello OTS.

Desarrollo: `pnpm install`, luego `pnpm build`, `pnpm test`, `pnpm lint` y `pnpm typecheck`.

## Idea en cinco líneas

1. Cada dato es un **evento firmado** (formato Nostr, NIP-01) e inmutable. La firma lo hace verificable sin confiar en quien lo almacena.
2. Los eventos se replican en **relays** que cualquiera puede operar (Cloudflare Workers gratis, una Raspberry Pi, un VPS). Ninguno es obligatorio.
3. El historial se empaqueta en **snapshots diarios** publicados por **BitTorrent + IPFS** y sellados en Bitcoin con **OpenTimestamps** (gratis).
4. La app es una **SPA React estática** distribuida por torrent/IPFS y con espejos en Vercel, Netlify y Cloudflare Pages.
5. **No se usa blockchain como base de datos**; solo como notario de fechas. El porqué está en [02-capa-de-datos](docs/spec/02-capa-de-datos.md).

## Índice de la especificación

| Documento | Contenido |
|---|---|
| [00-vision-y-alcance](docs/spec/00-vision-y-alcance.md) | Objetivos, no-objetivos, actores, casos de uso |
| [01-arquitectura](docs/spec/01-arquitectura.md) | Componentes, flujos, stack, estructura del repo |
| [02-capa-de-datos](docs/spec/02-capa-de-datos.md) | La "BD descentralizada": por qué no chain, modelo de consistencia |
| [03-modelo-de-eventos](docs/spec/03-modelo-de-eventos.md) | Kinds, tags y esquemas JSON (normativo) |
| [04-identidad-y-confianza](docs/spec/04-identidad-y-confianza.md) | Llaves, roles, anclas de confianza, anti-spam |
| [05-integracion-de-apps](docs/spec/05-integracion-de-apps.md) | Cómo se conecta una app o dispositivo: SDK, WebSocket, HTTP |
| [06-distribucion-y-persistencia](docs/spec/06-distribucion-y-persistencia.md) | Torrent/IPFS para la app y para los datos, snapshots, releases |
| [07-relay-referencia](docs/spec/07-relay-referencia.md) | Relay de referencia sobre Cloudflare Workers + D1 |
| [08-seguridad-y-privacidad](docs/spec/08-seguridad-y-privacidad.md) | Modelo de amenazas, datos personales, moderación |
| [09-roadmap](docs/spec/09-roadmap.md) | Fases con criterios de aceptación |
| [10-decisiones](docs/spec/10-decisiones.md) | Registro de decisiones (ADR) y preguntas cerradas |
| [11-priorizacion](docs/spec/11-priorizacion.md) | Prioridad MoSCoW de cada requisito y entregable de la v1 |

Diagrama de arquitectura (vista general y estructura del repo): [docs/arquitectura.drawio](docs/arquitectura.drawio). Se abre en [app.diagrams.net](https://app.diagrams.net) o con la extensión draw.io de VS Code.

Para agentes de IA: empezar por [AGENTS.md](AGENTS.md). Agente de desarrollo sin supervisión (bugs con etiqueta `agent` y roadmap, como PRs): [docs/operacion/agente.md](docs/operacion/agente.md).

## Licencia

Código y documentación bajo [Apache-2.0](LICENSE) (ADR-19). Los datos publicados en la red llevan la licencia que declara cada `dataset`; el mapa base es © colaboradores de OpenStreetMap (ODbL).
