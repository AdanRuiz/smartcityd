# 11 · Priorización (MoSCoW)

Qué se construye primero en la v1 y qué se deja fuera. El **cuándo** está en `09`; el **porqué** de cada decisión de diseño, en `10`.

## Cómo leer este documento

| Prioridad | Significado |
|---|---|
| **Must** | Sin esto la v1 no se publica: rompe un invariante de `AGENTS.md`, un objetivo de `00` o un caso de uso Must. |
| **Should** | Importante y previsto para la v1, pero la v1 puede publicarse sin ello si se documenta la carencia. |
| **Could** | Deseable. Entra solo si no retrasa nada Must ni Should. |
| **Won't** | Fuera de la v1 por decisión. No se implementa sin un ADR que lo cambie. |

| ID | Regla |
|---|---|
| PRIO-1 | MoSCoW y RFC 2119 son ejes distintos. DEBE/DEBERÍA/PUEDE dicen qué tiene que cumplir una implementación **cuando existe**; MoSCoW dice **si y cuándo** se construye. Las reglas `GW-*` son DEBE dentro del gateway, y el gateway entero es Could. |
| PRIO-2 | Una regla de seguridad o privacidad hereda la prioridad de la función que protege y es bloqueante para ella: no se entrega la función sin la regla. |
| PRIO-3 | Si hay que recortar, se recorta en este orden: Could, luego Should, y dentro de cada grupo primero lo de la fase más tardía. Lo Must no se recorta: se retrasa la v1. |
| PRIO-4 | Cambiar una prioridad exige un ADR en `10`. Un requisito nuevo recibe prioridad aquí en el mismo cambio que lo crea. |

## Casos de uso

| Caso de uso (`00`) | Prioridad | Motivo |
|---|---|---|
| 1. Calidad del aire comunitaria | Must | Ejercita el camino completo: fuente, relay, mapa, snapshot |
| 2. Reportes ciudadanos | Must sin foto; Should con foto | La foto necesita almacenamiento de adjuntos, que es opcional en el relay |
| 5. Datos abiertos reproducibles | Must | Es lo que demuestra que los datos sobreviven a los relays (GOAL-2) |
| 4. Estado de infraestructura | Should | Reutiliza la lógica de direccionables que ya exigen `city` y `dataset`; el costo está en la app |
| 3. Transporte público en vivo | Could | Depende de integrar a un operador de transporte; lo efímero no se archiva, así que no prueba nada de la persistencia |

## Entregables

### Must

| Entregable | Fase | Requisitos |
|---|---|---|
| `packages/schemas`: constantes de kind, esquemas y validadores de `city`, `dataset`, `source`, `observation`, `report`, `report_update`, `roles`, `snapshot`, `release` | 0 | EVT-1 a EVT-9, DATA-5, NFR-5 |
| Relay de referencia: WebSocket NIP-01, aceptación de eventos, reemplazo de direccionables, borrado kind 5, `POST`/`GET /v1/events`, NIP-11, límite de tasa | 1 | RELAY-1 a RELAY-3, ARCH-2, DATA-1 a DATA-4, DATA-6, DATA-8, SPAM-2, PRIV-8 |
| Medición de CPU y de filas por evento en la capa gratuita | 1 | GOAL-5, ADR-14 |
| SDK: cliente, firmantes local y NIP-07, pool de relays, validación, publicación y consulta, estado de relays | 2 | SDK-1 a SDK-3, SDK-5, SDK-6, SDK-9, SDK-10, REPL-1, REPL-2, REPL-4 a REPL-6, ID-1 a ID-4, ID-6, SEC-3 |
| App: mapa con MapLibre y PMTiles, capa de un dataset, panel de relays; build estático que abre desde `file://` | 2 | APP-1 a APP-3, APP-5, APP-7, APP-9, NFR-1, SEC-1, SEC-2, PRIV-7 |
| Ciudad piloto: custodios designados, evento `city`, dataset de calidad del aire | 2 | GOAL-6, TRUST-1 |
| Offline: almacén local y cola de salida | 3 | GOAL-7, NFR-3, SDK-4 |
| Reportes sin foto, `report_update`, llave desechable por reporte | 3 | PRIV-1 a PRIV-3, PRIV-5, PRIV-6 |
| Confianza: roles, niveles `verified`/`community`/`flagged`, filtro por nivel, llaves `blocked` | 3 | TRUST-3 a TRUST-5, TRUST-7, TRUST-9, TRUST-10 |
| Archivista: snapshot diario y adendas, torrent con web seeds e IPFS, evento `snapshot`, sello OpenTimestamps | 4 | SNAP-1 a SNAP-3, SNAP-5 a SNAP-7, SNAP-16, DIST-1 a DIST-3 |
| Relay: `GET /v1/export` por día, retención condicionada, importación de snapshots | 4 | RELAY-4, NFR-4, GOAL-2 |
| App en archivo único, evento `release`, al menos dos espejos | 4 | APP-4, GOAL-3 |
| Documentación pública suficiente para que un tercero integre sin tocar este repositorio | 5 | GOAL-1 |
| Un relay Nostr estándar, fuera de Cloudflare, sirviendo a la ciudad piloto | 5 | ARCH-1, invariante 1 |

### Should

| Entregable | Fase | Requisitos |
|---|---|---|
| Petición de almacenamiento persistente y aviso de respaldo de llave | 3 | SDK-11, ID-7 |
| Fotos en reportes: adjuntos, `PUT`/`GET /v1/blob` | 3 | PRIV-4, SEC-4 |
| Prueba de trabajo en relay y SDK | 3 | SPAM-1, SDK-8 |
| Service Worker para cargar el shell sin conexión (sin él la app funciona igual) | 3 | — |
| Etiquetas de moderadores (kind 1985) y denuncias (kind 1984) | 3 | `08`, moderación |
| El usuario edita anclas; agregados según nivel de confianza; huellas comparables con QR | 3 | TRUST-2, TRUST-6, TRUST-8 |
| Agrupación de lecturas en el SDK | 2 | SDK-7, DATA-9 |
| Límite de antigüedad en el relay y refirmado de la cola | 4 | RELAY-5, DATA-12, SDK-12 |
| Exportación por cursor de recepción y consolidado mensual | 4 | SNAP-4, SNAP-8, SNAP-9 |
| `sc.archive.read` y series históricas más allá de la retención de los relays | 4 | — |
| Build reproducible, aviso de versión nueva, pantalla "Acerca de", exportar e importar llave y ajustes | 4 | APP-6, APP-8, APP-10, APP-11 |
| Ciudad por IP y por ubicación del navegador, búsqueda de ciudades con sugerencias, mapa base mundial de respaldo | 4 | APP-12 a APP-16 |
| Kind `state` y caso de estacionamientos | 5 | — |
| Espejo entre relays por suscripción (`MIRROR_FROM`) | 5 | REPL-3 |
| Rotación automática de raíces por mayoría | 5 | TRUST-11, TRUST-12 |
| Ficha `app` (kind 31483) | 5 | — |
| Firmware de ejemplo para ESP32 con llave propia | 5 | ID-5 |
| Presupuesto de 500 KB de JS en la primera carga | 2 | NFR-2 |
| Tres o más seeders independientes por ciudad | 4 | DIST-4 |
| Redondeo sugerido de ubicación para fuentes en domicilios | 2 | PRIV-9 |

### Could

| Entregable | Fase | Requisitos |
|---|---|---|
| Kind `live` y caso de transporte en vivo | 5 | DATA-10 |
| Gateway IoT para dispositivos que no firman | 5 | GW-1 a GW-8 |
| Archivo mensual de adjuntos | 4 | SNAP-10 a SNAP-15 |
| Detección de valores atípicos entre fuentes vecinas | 3 | SPAM-3 |
| Siembra de snapshots desde la app por WebTorrent | 4 | DIST-5 |
| Directorio de apps y datasets dentro de la app | 5 | — |
| Verificación del sello OTS dentro de la app | 4 | SNAP-7 (parte opcional) |

### Won't (en la v1)

| Qué | Por qué | Referencia |
|---|---|---|
| Agregados columnares (Parquet) en snapshots | Optimización derivable del NDJSON; no añade datos | Q-4 |
| Reconciliación de conjuntos entre relays (NIP-77) | El espejo por suscripción basta al volumen del piloto | REPL-3 |
| Sincronización navegador a navegador (WebRTC) | Los tres planos ya cubren la caída de relays | `09` |
| Datos privados cifrados entre partes (NIP-44) | El sistema es para datos públicos | ADR-8 |
| Módulo con orden global: votación, fondos | Exige consenso; sería un módulo aparte | Q-3 |
| Firma de umbral (FROST) para las raíces | La mayoría de firmas independientes resuelve lo mismo sin criptografía nueva | ADR-13 |
| Un hub por ciudad en el relay de referencia | Cambio interno sin efecto en el protocolo; solo si la medición lo exige | Q-5 |
| Geohash a precisión 7 | El recorte exacto ya se hace en el cliente | ADR-17 |
| Escritura por defecto en relays públicos generales | No validan esquemas ni garantizan conservar estos kinds | ADR-16 |
| Dependencia de servicios de fijado IPFS | Sus condiciones cambian; el torrent con web seeds no depende de ellos | ADR-15 |
| Proponer un NIP propio | No hay colisión que lo haga urgente | ADR-12 |
| Verificación de firmas diferida o por muestreo; llaves de respaldo con bloqueo temporal; adjuntos obligatorios en el consolidado; detección de Base64 | Descartadas con motivo | `10`, propuestas descartadas |
| Pagos, datos personales, control de actuadores, tiempo real duro | No-objetivos | `00` |

## Prioridad por requisito

Cada ID de la spec aparece una sola vez. Los números son los del ID dentro de su familia.

| Familia | Doc | Must | Should | Could |
|---|---|---|---|---|
| GOAL | `00` | 1–7 | — | — |
| NFR | `00` | 1, 3, 4, 5 | 2 | — |
| ARCH | `01` | 1, 2 | — | — |
| DATA | `02` | 1–8, 11 | 9, 12 | 10 |
| REPL | `02` | 1, 2, 4, 5, 6 | 3 | — |
| EVT | `03` | 1–9 | — | — |
| ID | `04` | 1, 2, 3, 4, 6 | 5, 7 | — |
| TRUST | `04` | 1, 3, 4, 5, 7, 9, 10 | 2, 6, 8, 11, 12 | — |
| SPAM | `04` | 2 | 1 | 3 |
| SDK | `05` | 1–6, 9, 10 | 7, 8, 11, 12 | — |
| GW | `05` | — | — | 1–8 |
| DIST | `06` | 1, 2, 3 | 4 | 5 |
| APP | `06` | 1–5, 7, 9 | 6, 8, 10–16 | — |
| SNAP | `06` | 1, 2, 3, 5, 6, 7, 16 | 4, 8, 9 | 10–15 |
| RELAY | `07` | 1–4 | 5 | — |
| SEC | `08` | 1, 2, 3, 5, 6 | 4 | — |
| PRIV | `08` | 1, 2, 3, 5, 6, 7, 8 | 4, 9 | — |

Ningún requisito con ID es Won't: lo que queda fuera de la v1 son entregables sin regla propia, listados arriba.

Notas sobre las asignaciones menos obvias:

- **DATA-10, DATA-11, PRIV-4, SEC-4** siguen a su función (PRIO-2): DATA-10 solo aplica si se entrega `live`; PRIV-4 y SEC-4, si se entregan fotos. DATA-11 es Must porque prohíbe meter binarios en eventos, haya o no fotos.
- **EVT-9 y los esquemas de `state` y `live`** son baratos y entran en `packages/schemas` desde la fase 0 aunque su uso en la app sea Should o Could: fijar el formato pronto evita un cambio incompatible después.
- **SNAP-7** es Must en la CLI del archivista (`--verify`) y Could en la app.
- **TRUST-9** es Must sin costo: es una prohibición, no una función.
- **REPL-3** es Should solo en su variante por suscripción; la variante NIP-77 es Won't.
- **RELAY-5** es Should porque un relay sin límite de antigüedad sigue siendo correcto; lo que se encarece es el trabajo del archivista (SNAP-8).
- **RELAY-4** es Must aunque la purga llegue en la fase 4: un relay que borra datos sin archivar incumple GOAL-2. Hasta entonces el relay no purga.
