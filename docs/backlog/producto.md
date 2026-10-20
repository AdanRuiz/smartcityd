# Product backlog

Documento operativo, no normativo. La prioridad de cada entregable está en [`11-priorizacion`](../spec/11-priorizacion.md) y el orden de las fases en [`09-roadmap`](../spec/09-roadmap.md); si el backlog los contradice, ganan ellos.

**Lo pendiente vive en issues de GitHub** con la etiqueta [`backlog`](https://github.com/AdanRuiz/smartcityd/issues?q=is%3Aissue+is%3Aopen+label%3Abacklog+sort%3Acreated-asc), un issue por ítem (`PB-n · título`). Este archivo guarda las reglas, la meta de cada fase y el registro de lo ya hecho.

**Fase actual:** 4 · Persistencia: snapshots y distribución de la app ([pendientes](https://github.com/AdanRuiz/smartcityd/issues?q=is%3Aissue+is%3Aopen+label%3Abacklog+label%3Afase-4+sort%3Acreated-asc)).
**Meta de la fase** (el "Hecho cuando" de `09`):
1. Un relay vacío se reconstruye solo desde snapshots (NFR-4). Hecho en código (#5).
2. `smartcity.html` descargado por torrent, abierto desde `file://` y sin el espejo principal disponible, muestra datos en vivo.
3. La prueba OTS de un snapshot verifica contra Bitcoin.

**Adelanto permitido:** Fase 5 ([pendientes](https://github.com/AdanRuiz/smartcityd/issues?q=is%3Aissue+is%3Aopen+label%3Abacklog+label%3Afase-5+sort%3Acreated-asc)).

**Sprint actual:** [milestone `2026-W43`](https://github.com/AdanRuiz/smartcityd/milestone/1), del lunes 19 al domingo 25 de octubre. Objetivo: cerrar el único Must técnico de la fase y dejar listos los despliegues que desbloquean los criterios 2 y 3.

## Cómo se usa

- **Fase = meta; sprint = semana.** La fase dice qué hay que lograr y puede ocupar varios sprints. El sprint dura una semana ISO, de lunes a domingo, y es un milestone con su nombre (`2026-W43`) y fecha de cierre el domingo.
- **Etiquetas.** Cada issue lleva `backlog`, su prioridad (`must`, `should`, `could`), su fase (`fase-4`, `fase-5`) y `humano` si exige una persona (custodios, cuentas, dominios, máquinas, despliegues, llaves o secretos). Lo que no es `humano` lo puede hacer el agente en una sesión con tests.
- **Orden.** Los issues se crearon en orden de prioridad: dentro de una fase y una prioridad, el número más bajo va primero. Para subir o bajar uno, se le cambia la etiqueta de prioridad o se anota en el issue.
- **Planeación (lunes).** El mantenedor crea el milestone de la semana (después lo hará `run.ps1`), le asigna los ítems en orden y escribe el objetivo en su descripción. Toma primero los del agente y los humanos que desbloquean a otros, sin pasar de la fase actual ni de la de adelanto.
- **Durante el sprint.** El agente toma el issue abierto sin `humano` de número más bajo del milestone. Si se acaban, sigue con el siguiente de la fase actual por prioridad y número, y después con los de la fase de adelanto, nunca de una más lejana. Su PR lleva `Closes #n` y, al mezclarlo, el issue se cierra.
- **Revisión (domingo o lunes).** Lo abierto se quita del milestone y vuelve al backlog: no pasa solo al sprint siguiente. El milestone se cierra. Si la meta de la fase se cumplió, se cierra la fase: se cambia "Fase actual" aquí.
- **Arrastre.** Lo Should y lo Could que no entraron en su fase pasan a la fase actual (`09`) con la etiqueta de la fase nueva; el cuerpo del issue dice de cuál viene. También pasan los Must humanos de fases cuyo objetivo ya se cumplió.
- **Ítems nuevos o partidos.** Un ítem nuevo es un issue con `backlog` y el siguiente `PB-n` libre (hoy, **PB-72**). Al partir uno, sus partes toman números nuevos y el original se cierra enlazándolas. Los `PB-n` no se reutilizan.
- **Hecho.** Al cerrar una fase, sus ítems hechos se registran abajo con su PR.

Mientras no cambie `scripts/agent/`, el agente sigue eligiendo su tarea desde `09` y `11` y los issues de backlog no llevan la etiqueta `agent`, para que el flujo de bugs no los tome (ver [`operacion/agente.md`](../operacion/agente.md)).

## Hecho

### Fase 4 (en curso)

| ID | Ítem | MoSCoW | Fase | Quién | Estado | Requisitos | Aceptación y notas |
|---|---|---|---|---|---|---|---|
| PB-2 | Relay: exportación por día (`GET /v1/export?c=&day=`) | Must | 4 | agente | hecho · #1 | RELAY-4, NFR-4 | |
| PB-3 | Relay: retención condicionada a snapshots archivados | Must | 4 | agente | hecho · #3, #6 | RELAY-4, GOAL-2 | |
| PB-4 | Relay: importación de snapshots | Must | 4 | agente | hecho · #5 | NFR-4, SNAP-6 | |
| PB-5 | Archivista: archivo diario y evento `snapshot` | Must | 4 | agente | hecho · #7 | SNAP-1, SNAP-3, SNAP-5 | |
| PB-6 | Archivista: adendas de eventos tardíos | Must | 4 | agente | hecho · #10 | SNAP-2 | |
| PB-7 | Eventos con `expiration` fuera del archivo | Must | 4 | agente | hecho · #8 | SNAP-16, ADR-21 | |
| PB-8 | Archivista: torrent con web seeds y CID de IPFS | Must | 4 | agente | hecho · #13, #14 | DIST-1 a DIST-3 | |
| PB-9 | Archivista: firma y publicación del evento `snapshot` | Must | 4 | agente | hecho · #16 | DIST-2, SNAP-6 | |
| PB-10 | Archivista: sello OpenTimestamps (sellar, completar, publicar kind 1040, `--verify`) | Must | 4 | agente | hecho · #19–#22 | SNAP-7 | |
| PB-11 | App en archivo único `smartcity.html` | Must | 4 | agente | hecho · #17 | APP-4, SEC-2 | |
| PB-12 | Evento `release`: borrador, CID de `dist/` y magnet de `smartcity.html` | Must | 4 | agente | hecho · #18, #23 | APP-4, DIST-2, GOAL-3 | |
| PB-13 | Configuración de los espejos Netlify y Vercel | Must | 4 | agente | hecho · #31 | GOAL-3 | |
| PB-29 | Relay: límite de antigüedad y refirmado de la cola en el SDK | Should | 4 | agente | hecho · #28 | RELAY-5, DATA-12, SDK-12 | |
| PB-30 | Relay y archivista: exportación por cursor de recepción y adendas con `archiver late` | Should | 4 | agente | hecho · #29, #30 | SNAP-8 | |
| PB-31 | App: pantalla «Acerca de» | Should | 4 | agente | hecho · #34 | APP-10 | |
| PB-32 | App: exportar e importar llave y ajustes | Should | 4 | agente | hecho · #35 | APP-11 | |
| PB-33 | App: ciudad por IP y por ubicación, búsqueda de ciudades, mapa base mundial | Should | 4 | agente | hecho · #9, #11 | APP-12 a APP-16 | |
| PB-34 | App multiciudad: la ciudad de los datos sigue a la elegida, anclas por ciudad | Should | 4 | agente | hecho · #26 | APP-17, APP-18 | |

### Fase 5 (adelanto)

| ID | Ítem | MoSCoW | Fase | Quién | Estado | Requisitos | Aceptación y notas |
|---|---|---|---|---|---|---|---|
| PB-48 | Guías públicas para que un tercero integre sin tocar este repositorio | Must | 5 | agente | hecho · #24, #25, #27, #33 | GOAL-1 | Los scripts de las cuatro guías corren en los tests contra el relay de referencia |
| PB-49 | Relay Nostr estándar fuera de Cloudflare: código y despliegue con Docker | Must | 5 | agente | hecho · d2a6fbb | ARCH-1 | `services/relay-strfry` |
| PB-57 | Ficha `app` (kind 31483) | Should | 5 | agente | hecho · #33 | — | Esquema y guía de dispositivos |

### Fases cerradas

<details>
<summary>Fase 3 · Offline, reportes y confianza (objetivo cumplido en código)</summary>

| ID | Ítem | MoSCoW | Fase | Quién | Estado | Requisitos | Aceptación y notas |
|---|---|---|---|---|---|---|---|
| PB-63 | Almacén local y cola de salida | Must | 3 | agente | hecho · 34ea31d, edc2d43 | GOAL-7, NFR-3, SDK-4 | |
| PB-64 | Reportes sin foto, `report_update` y llave desechable por reporte | Must | 3 | agente | hecho · 34ea31d, edc2d43 | PRIV-1 a PRIV-3, PRIV-5, PRIV-6 | |
| PB-65 | Confianza: roles, niveles, filtro por nivel y llaves `blocked` | Must | 3 | agente | hecho · 201e195, 34ea31d | TRUST-3 a TRUST-5, TRUST-7, TRUST-9, TRUST-10 | |
| PB-66 | Almacenamiento persistente, aviso de respaldo de llave, edición de anclas, Service Worker, etiquetas y denuncias de moderadores | Should | 3 | agente | hecho · edc2d43 | SDK-11, ID-7, TRUST-2, `08` | |
| PB-67 | Prueba de trabajo en relay y SDK | Should | 3 | agente | hecho · 201e195, 34ea31d | SPAM-1, SDK-8 | |

</details>

<details>
<summary>Fase 2 · SDK y primer caso de uso de extremo a extremo (objetivo cumplido)</summary>

| ID | Ítem | MoSCoW | Fase | Quién | Estado | Requisitos | Aceptación y notas |
|---|---|---|---|---|---|---|---|
| PB-68 | SDK: cliente, firmantes, pool de relays, validación, publicación, consulta y agrupación de lecturas | Must | 2 | agente | hecho · 47d0165 | SDK-1 a SDK-3, SDK-5 a SDK-7, SDK-9, SDK-10, REPL-1, REPL-2, REPL-4 a REPL-6, ID-1 a ID-4, ID-6, SEC-3 | |
| PB-69 | App: mapa, capa de un dataset, panel de relays; dos relays y espejo en Cloudflare Pages | Must | 2 | agente | hecho · 75767df, 8d4607e | APP-1 a APP-3, APP-5, APP-7, APP-9, NFR-1, SEC-1, SEC-2, PRIV-7 | p95 de 225 ms entre publicar y recibir |

Los custodios y el evento `city` pasaron a la fase 4 (PB-21, PB-22; issues #45 y #46).

</details>

<details>
<summary>Fase 1 · Relay mínimo y prueba de capacidad (cerrada)</summary>

| ID | Ítem | MoSCoW | Fase | Quién | Estado | Requisitos | Aceptación y notas |
|---|---|---|---|---|---|---|---|
| PB-70 | Relay de referencia y medición de CPU y filas por evento en la capa gratuita | Must | 1 | agente | hecho · 3ff84e0 | RELAY-1 a RELAY-3, ARCH-2, DATA-1 a DATA-4, DATA-6, DATA-8, SPAM-2, PRIV-8, GOAL-5, ADR-14 | La verificación en JavaScript cabe (ADR-14, opción 1) |

</details>

<details>
<summary>Fase 0 · Cimientos (cerrada)</summary>

| ID | Ítem | MoSCoW | Fase | Quién | Estado | Requisitos | Aceptación y notas |
|---|---|---|---|---|---|---|---|
| PB-71 | Monorepo, CI y `packages/schemas` | Must | 0 | agente | hecho · 9d1869d | EVT-1 a EVT-9, DATA-5, NFR-5 | |

</details>

## Fuera de la v1

Lo Won't está en [`11`](../spec/11-priorizacion.md#wont-en-la-v1) y no entra a este backlog sin un ADR que lo cambie.
