# Product backlog

Documento operativo, no normativo. La prioridad de cada entregable está en [`11-priorizacion`](../spec/11-priorizacion.md) y el orden de las fases en [`09-roadmap`](../spec/09-roadmap.md); si este archivo los contradice, ganan ellos.

**Fase actual:** 4 · Persistencia: snapshots y distribución de la app.
**Meta de la fase** (el "Hecho cuando" de `09`):
1. Un relay vacío se reconstruye solo desde snapshots (NFR-4). Hecho en código (#5).
2. `smartcity.html` descargado por torrent, abierto desde `file://` y sin el espejo principal disponible, muestra datos en vivo.
3. La prueba OTS de un snapshot verifica contra Bitcoin.

**Adelanto permitido:** Fase 5.

## Sprint actual: 2026-W43 (lunes 19 a domingo 25 de octubre)

**Objetivo:** cerrar el único Must técnico de la fase y dejar listos los despliegues que desbloquean los criterios 2 y 3.

| Quién | Ítems, en orden |
|---|---|
| agente | PB-1, PB-23, PB-24, PB-27, PB-28, PB-25, PB-38, PB-39 |
| humano | PB-15, PB-14, PB-18, PB-16 |

## Cómo se usa

- **Fase = meta; sprint = semana.** La fase dice qué hay que lograr y puede ocupar varios sprints. El sprint dura una semana ISO, de lunes a domingo, y se nombra por ella (`2026-W43`).
- **Planeación (lunes).** El mantenedor elige los ítems de la semana, en orden, y escribe un objetivo de una línea. Toma primero los del agente y los humanos que desbloquean a otros, sin pasar de la fase actual ni de la de adelanto.
- **Revisión (domingo o lunes).** Mezcla lo pendiente, marca lo que quedó hecho y devuelve al backlog lo que no se terminó: no pasa solo al sprint siguiente. Si la meta de la fase se cumplió, cierra la fase: pliega su tabla al final del archivo y cambia la línea "Fase actual".
- **Orden.** Dentro del sprint, el agente toma el primer ítem `pendiente` de tipo `agente`. Si se acaban antes del domingo, sigue con el siguiente ítem `agente` de la fase actual, en el orden de su tabla, y después con los de la fase de adelanto, nunca de una más lejana. Cada tabla de fase está en orden de prioridad: primero Must, luego Should, luego Could.
- **Arrastre.** Lo Should y lo Could que no entraron en su fase pasan a la fase actual (`09`) con su fase de origen en la columna *Fase*. También pasan los Must humanos de fases cuyo objetivo ya se cumplió.
- **Estados:** `pendiente`, `en curso`, `hecho · #PR` (o el commit, en lo anterior a los PRs) y `bloqueado`, con el motivo en *Aceptación y notas*.
- **Quién:** `agente` si se puede terminar en una sesión con tests, o `humano` si exige una persona (custodios, cuentas, dominios, máquinas, despliegues, llaves o secretos).
- **Qué puede cambiar el agente:** el estado de su ítem, en el mismo PR que lo implementa, y partir un ítem en varios con IDs nuevos. No cambia prioridades ni el orden; eso se revisa en el PR.
- **IDs.** Los `PB-n` no se reutilizan. Un ítem nuevo toma el siguiente número libre (hoy, **PB-72**). Los ítems terminados no se borran.

Mientras no cambie `scripts/agent/`, el agente sigue eligiendo su tarea desde `09` y `11` (ver [`operacion/agente.md`](../operacion/agente.md)).

## Fase 4 · Persistencia: snapshots y distribución de la app (fase actual)

| ID | Ítem | MoSCoW | Fase | Quién | Estado | Requisitos | Aceptación y notas |
|---|---|---|---|---|---|---|---|
| PB-1 | Relay: rechazar escrituras con `restricted: storage full` cuando el almacenamiento se llena y no hay días archivados que purgar | Must | 4 | agente | pendiente | RELAY-4, ADR-20 | Test: con la base llena y sin anclas, un `EVENT` recibe `OK false` con ese prefijo y no se borra nada sin archivar |
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
| PB-14 | Conectar el repositorio en Netlify y en Vercel | Must | 4 | humano | pendiente | GOAL-3 | La app abre en los dos espejos desde el mismo commit |
| PB-15 | Volver a desplegar los dos relays de referencia | Must | 4 | humano | pendiente | SNAP-8, RELAY-4, SPAM-1 | Activa `received_after`, el cron de purga y la prueba de trabajo |
| PB-16 | Subir los archivos de un snapshot real a los web seeds y fijarlos en IPFS | Must | 4 | humano | pendiente | DIST-1 a DIST-3 | |
| PB-17 | Verificar contra Bitcoin la prueba OTS de un snapshot real | Must | 4 | humano | pendiente | SNAP-7 | Criterio 3 del sprint. Depende de PB-16 |
| PB-18 | Designar la llave de desarrollador y firmar el primer `release` | Must | 4 | humano | pendiente | APP-4, DIST-2 | |
| PB-19 | Sembrar el torrent de `smartcity.html` y fijar `dist/` en IPFS | Must | 4 | humano | pendiente | DIST-1, DIST-3 | Depende de PB-18 |
| PB-20 | Prueba de salida: `smartcity.html` por torrent, desde `file://` y sin el espejo principal, muestra datos en vivo | Must | 4 | humano | pendiente | GOAL-3, APP-4 | Criterio 2 del sprint. Depende de PB-15 y PB-19 |
| PB-21 | Designar los custodios de las llaves raíz de la ciudad piloto | Must | 2 | humano | bloqueado | TRUST-11, GOAL-6 | Al menos tres, de organizaciones distintas, con una llave fuera de línea. La herramienta ya existe (`operacion/ciudad-piloto.md`) |
| PB-22 | Publicar el evento `city` y el dataset de calidad del aire de la ciudad piloto | Must | 2 | humano | bloqueado | GOAL-6, TRUST-1 | Depende de PB-21 |
| PB-23 | Archivista: alternativa de SNAP-8 por `since` para relays sin `received_after` | Should | 4 | agente | pendiente | SNAP-8 | Test con un relay sin la ruta: consulta la ventana del máximo de antigüedad que declara en NIP-11 y escribe las adendas |
| PB-24 | Archivista: consolidado mensual que agrupa diarios y adendas en un solo torrent | Should | 4 | agente | pendiente | SNAP-4, SNAP-9 | Se genera solo cuando el mes pasó el límite de antigüedad (30 días); evento `snapshot` `monthly` con `cid`, `magnet` y `urls` |
| PB-25 | SDK: `sc.archive.read` para leer un día desde sus snapshots | Should | 4 | agente | pendiente | SNAP-6 | Verifica hashes y firmas, une diario y adendas y aplica borrados, como `desarrolladores/historial.md` |
| PB-26 | App: series históricas más allá de la retención de los relays | Should | 4 | agente | pendiente | SNAP-6 | Depende de PB-25 |
| PB-27 | App: aviso de versión nueva desde el `release` firmado por las llaves de desarrollador embebidas | Should | 4 | agente | pendiente | APP-8 | Si hay versión mayor, avisa y ofrece los canales |
| PB-28 | Build reproducible: `SOURCE_DATE_EPOCH` y lockfile | Should | 4 | agente | pendiente | APP-6 | Dos builds del mismo commit dan el mismo sha256 de `smartcity.html` |
| PB-29 | Relay: límite de antigüedad y refirmado de la cola en el SDK | Should | 4 | agente | hecho · #28 | RELAY-5, DATA-12, SDK-12 | |
| PB-30 | Relay y archivista: exportación por cursor de recepción y adendas con `archiver late` | Should | 4 | agente | hecho · #29, #30 | SNAP-8 | |
| PB-31 | App: pantalla «Acerca de» | Should | 4 | agente | hecho · #34 | APP-10 | |
| PB-32 | App: exportar e importar llave y ajustes | Should | 4 | agente | hecho · #35 | APP-11 | |
| PB-33 | App: ciudad por IP y por ubicación, búsqueda de ciudades, mapa base mundial | Should | 4 | agente | hecho · #9, #11 | APP-12 a APP-16 | |
| PB-34 | App multiciudad: la ciudad de los datos sigue a la elegida, anclas por ciudad | Should | 4 | agente | hecho · #26 | APP-17, APP-18 | |
| PB-35 | Relay: `PUT`/`GET /v1/blob` para adjuntos | Should | 3 | agente | pendiente | PRIV-4, SEC-4 | Opcional en el relay. Direccionado por hash: `GET` devuelve el contenido cuyo sha256 se pidió |
| PB-36 | SDK: subir y leer la foto de un reporte | Should | 3 | agente | pendiente | PRIV-4, SEC-4 | Verifica el hash antes de mostrar y muestra desde un `blob:` local (SEC-4). Depende de PB-35 |
| PB-37 | App: foto en reportes | Should | 3 | agente | pendiente | PRIV-4, SEC-4 | Quita EXIF, redimensiona a ≤ 1600 px de lado mayor y recuerda no incluir rostros ni matrículas (PRIV-4). Depende de PB-36 |
| PB-38 | App: agregados según nivel de confianza | Should | 3 | agente | pendiente | TRUST-6 | Usa solo `verified` si el dataset tiene fuentes verificadas, si no `community`, y la app indica cuál usa |
| PB-39 | App: código QR de las huellas de raíces vigentes y propuestas | Should | 3 | agente | pendiente | TRUST-8 | Sin dependencias nuevas. Si hace falta una librería, termina en `BLOQUEADO:` y la nombra |
| PB-40 | App: bajar la primera carga a 500 KB de JS comprimido | Should | 2 | agente | pendiente | NFR-2 | Hoy ~583 KB. Opción: cargar el worker de MapLibre como archivo aparte fuera de `file://` (ver `apps/web/README.md`) |
| PB-41 | App: sugerir redondear a 3 decimales la ubicación de fuentes en domicilios | Should | 2 | agente | pendiente | PRIV-9 | Las guías ya lo indican; falta la sugerencia en la app |
| PB-42 | Tres o más seeders independientes por ciudad | Should | 4 | humano | pendiente | DIST-4 | Del archivo y de la app |
| PB-43 | Archivista: paquete anual con los consolidados mensuales | Could | 4 | agente | pendiente | SNAP-17, ADR-24 | Depende de PB-24 |
| PB-44 | Archivista: archivo mensual de adjuntos | Could | 4 | agente | pendiente | SNAP-10 a SNAP-15 | Depende de PB-35 |
| PB-45 | App: siembra de snapshots por WebTorrent | Could | 4 | agente | pendiente | DIST-5 | |
| PB-46 | App: verificación del sello OTS | Could | 4 | agente | pendiente | SNAP-7 (parte opcional) | |
| PB-47 | Detección de valores atípicos entre fuentes vecinas | Could | 3 | agente | pendiente | SPAM-3 | |

## Fase 5 · Apertura a terceros (adelanto)

| ID | Ítem | MoSCoW | Fase | Quién | Estado | Requisitos | Aceptación y notas |
|---|---|---|---|---|---|---|---|
| PB-48 | Guías públicas para que un tercero integre sin tocar este repositorio | Must | 5 | agente | hecho · #24, #25, #27, #33 | GOAL-1 | Los scripts de las cuatro guías corren en los tests contra el relay de referencia |
| PB-49 | Relay Nostr estándar fuera de Cloudflare: código y despliegue con Docker | Must | 5 | agente | hecho · d2a6fbb | ARCH-1 | `services/relay-strfry` |
| PB-50 | Desplegar el relay strfry en una máquina con dominio y sumarlo a la ciudad piloto | Must | 5 | humano | pendiente | ARCH-1, invariante 1 | |
| PB-51 | Prueba de salida: una app externa, escrita solo con la documentación pública, publica un dataset nuevo y lo consume | Must | 5 | humano | pendiente | GOAL-1 | Objetivo de la fase 5. Mejor si la escribe alguien ajeno al proyecto |
| PB-52 | SDK: publicación y consulta del kind `state` | Should | 5 | agente | pendiente | — | El esquema ya existe en `packages/schemas` |
| PB-53 | App: capa de estado de infraestructura y caso de estacionamientos | Should | 5 | agente | pendiente | — | Caso de uso 4. Depende de PB-52 |
| PB-54 | Relay: espejo por suscripción (`MIRROR_FROM`) | Should | 5 | agente | pendiente | REPL-3 | Test con dos relays locales: lo publicado en uno aparece en el otro |
| PB-55 | SDK: aceptar automáticamente una nueva definición `city` firmada por mayoría estricta de las raíces conocidas | Should | 5 | agente | pendiente | TRUST-12 | `city.mjs verify` ya comprueba la mayoría; falta en el cliente |
| PB-56 | App: mostrar la rotación de raíces que no llega a mayoría como propuesta pendiente | Should | 5 | agente | pendiente | TRUST-11, TRUST-12 | Depende de PB-55 |
| PB-57 | Ficha `app` (kind 31483) | Should | 5 | agente | hecho · #33 | — | Esquema y guía de dispositivos |
| PB-58 | Firmware de ejemplo para ESP32 con llave propia | Should | 5 | agente | pendiente | ID-5 | Sin compilarlo en el CI, si eso exige dependencias nuevas |
| PB-59 | SDK: kind `live` | Could | 5 | agente | pendiente | DATA-10 | El esquema ya existe |
| PB-60 | App: caso de transporte en vivo | Could | 5 | agente | pendiente | DATA-10 | Depende de PB-59 |
| PB-61 | `services/gateway-worker` para dispositivos que no firman | Could | 5 | agente | pendiente | GW-1 a GW-8 | Partir en ítems al empezarlo |
| PB-62 | Directorio de apps y datasets dentro de la app | Could | 5 | agente | pendiente | — | |

## Fases cerradas

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

Los custodios y el evento `city` pasaron a la fase 4 (PB-21, PB-22).

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
