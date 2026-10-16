# SmartCity descentralizado

Especificación de una plataforma de ciudad inteligente sin servidor central: cualquier app o dispositivo puede publicar y leer datos urbanos, y tanto la app como los datos sobreviven aunque desaparezca quien los creó.

Estado: **especificación v1.0 (cerrada el 2026-10-12)**. Sin preguntas abiertas; requisitos priorizados con MoSCoW en [11-priorizacion](docs/spec/11-priorizacion.md). Implementación: fase 0 de [09-roadmap](docs/spec/09-roadmap.md) completa (monorepo y `packages/schemas`); fase 1 completa: relay de referencia en [`services/relay-worker`](services/relay-worker), desplegado y medido en Cloudflare; la verificación de firma en JavaScript cabe (ADR-14, opción 1; mediciones en su README). Siguiente: fase 2 (SDK y app).

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

Para agentes de IA: empezar por [AGENTS.md](AGENTS.md).
