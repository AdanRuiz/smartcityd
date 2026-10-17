# 10 · Decisiones y preguntas cerradas

## Decisiones (ADR)

Formato: contexto → decisión → consecuencias. Estado: **aceptada** salvo que se indique.

### ADR-1 · Eventos firmados en vez de blockchain
- **Contexto:** se necesita una base de datos sin dueño, gratuita y verificable.
- **Decisión:** registro de eventos firmados replicado en relays; sin cadena propia ni escritura en cadenas públicas.
- **Consecuencias:** sin orden global ni consenso; consistencia eventual; costo cero; el borrado en relays es posible. Detalle en `02`.

### ADR-2 · Compatibilidad con Nostr (NIP-01) en vez de protocolo propio
- **Contexto:** el diseño natural (evento firmado + relay tonto) ya existe y tiene librerías, relays y herramientas.
- **Decisión:** el formato de evento, los filtros y el protocolo WebSocket son NIP-01 sin cambios; lo propio son los kinds, tags y esquemas.
- **Consecuencias:** cualquier relay Nostr sirve; se hereda secp256k1/Schnorr; las consultas se limitan a lo que expresan los filtros (sin rangos geográficos ni agregados en servidor).

### ADR-3 · Bitcoin solo como sello de tiempo vía OpenTimestamps
- **Contexto:** `created_at` no es confiable y se quiere probar que los datos existían en una fecha.
- **Decisión:** sellar el `id` de cada evento `snapshot`.
- **Consecuencias:** una prueba por día y ciudad, gratis; granularidad de un día más el periodo de gracia; dependencia opcional.

### ADR-4 · Snapshots NDJSON en torrent + IPFS como plano frío
- **Contexto:** los relays gratuitos tienen almacenamiento y retención limitados.
- **Decisión:** archivo diario determinista, anunciado por evento, sembrado por voluntarios.
- **Consecuencias:** el historial no depende de ningún relay; consultar historial exige descargar y procesar en el cliente; la permanencia depende de que haya seeders.

### ADR-5 · Escritura abierta, confianza en el lector
- **Contexto:** un sistema con permiso de escritura centralizado ya no sería descentralizado.
- **Decisión:** cualquiera publica; el cliente clasifica con anclas y roles.
- **Consecuencias:** habrá ruido y spam en la capa `community`; la calidad de la experiencia depende de buenos valores por defecto en la app.

### ADR-6 · App estática de archivo único, sin backend
- **Contexto:** la app debe sobrevivir a su hosting y poder circular por torrent.
- **Decisión:** SPA React 100 % estática, `HashRouter`, rutas relativas, variante en un solo HTML.
- **Consecuencias:** sin SSR ni SEO; sin secretos en la app; toda la lógica en el cliente; el tamaño del paquete importa.

### ADR-7 · Cloudflare Workers + D1 para el relay de referencia
- **Contexto:** hace falta un relay desplegable gratis y sin administrar servidores.
- **Decisión:** Workers + Durable Objects con hibernación + D1.
- **Consecuencias:** capacidad acotada por la capa gratuita (~10⁴ eventos/día por relay); concentración en un proveedor que se compensa exigiendo relays en otra infraestructura (fase 5).

### ADR-8 · Sin datos personales por diseño
- **Contexto:** un archivo distribuido no puede garantizar supresión.
- **Decisión:** los esquemas excluyen datos personales; llaves desechables para reportes.
- **Consecuencias:** quedan fuera casos como trámites o identidad ciudadana.

### ADR-9 · PMTiles para el mapa base
- **Contexto:** un servidor de teselas sería una dependencia central.
- **Decisión:** un archivo PMTiles por ciudad, distribuido como cualquier otro artefacto.
- **Consecuencias:** mapa utilizable offline y desde espejos; hay que regenerar el extracto para actualizar el mapa.

### ADR-10 · Archivo de adjuntos opcional y separado
- **Contexto:** las fotos de reportes pueden desaparecer de su alojamiento, pero son también lo único retirable del sistema.
- **Decisión:** un archivista puede publicar un torrent mensual de adjuntos, separado del de eventos, tras 30 días de margen para moderación y excluyendo lo marcado o borrado. No es obligatorio.
- **Consecuencias:** algunos adjuntos se perderán; a cambio, sembrar el historial de eventos no implica distribuir fotos sin moderar. Detalle en `06`.

### ADR-11 · Límite de antigüedad y exportación por orden de recepción
- **Contexto:** sin tope, un evento puede antedatarse sin límite y el archivista tendría que revisar todos los días pasados en busca de tardíos.
- **Decisión:** el relay de referencia rechaza eventos regulares de clientes con más de 30 días (configurable) y ofrece exportación por cursor de recepción.
- **Consecuencias:** un cliente offline más de 30 días debe volver a firmar su cola (SDK-12); las adendas de un día se cierran a los 30 días.

### ADR-12 · Números de kind asignados
- **Contexto:** los kinds eran provisionales hasta comprobar colisiones (Q-1).
- **Decisión:** se quedan `1480`–`1483`, `21480` y `31480`–`31486`. El 2026-10-12 se revisó la tabla de kinds del repositorio `nostr-protocol/nips`: ninguno está registrado ni cae dentro de un rango reservado; los vecinos más cercanos son `1337` y `1617`, `21059` y `22242`, `31234` y `31922`.
- **Consecuencias:** la comprobación cubre el registro oficial, no el uso informal en relays públicos, que no tiene registro. Si aparece un choque real, mover el bloque es un cambio incompatible: por eso el código sigue importando los números de `packages/schemas`. Proponer un NIP propio queda como opción posterior a la v1.

### ADR-13 · Rotación de raíces por mayoría estricta
- **Contexto:** hacía falta elegir entre mayoría de firmas independientes y firma de umbral (Q-2).
- **Decisión:** mayoría estricta de las raíces conocidas, cada una publicando la misma definición `city` (TRUST-12). Sin FROST ni multisig en la v1.
- **Consecuencias:** no requiere criptografía nueva ni coordinación en línea entre custodios; la verificación la hace cualquier cliente con lo que ya tiene. A cambio, el cliente debe reunir varios eventos y la lista de raíces es pública.

### ADR-14 · Verificación de firma siempre completa en el relay
- **Contexto:** no se sabe aún si la verificación Schnorr cabe en el límite de CPU de la capa gratuita de Workers (Q-6). Una de las alternativas planteadas era verificar por muestreo.
- **Decisión:** el relay verifica `id` y `sig` de cada evento antes de escribir (RELAY-1); el muestreo y la verificación diferida quedan descartados porque contradicen el invariante 2 de `AGENTS.md`. Orden de alternativas, que se recorre con la medición de la fase 1: (1) verificación en JavaScript con `@noble/curves`; (2) verificación en WASM; (3) si ninguna cabe, el relay sobre Workers se documenta como despliegue que requiere plan de pago y el despliegue de costo cero pasa a ser un relay estándar en hardware propio (ARCH-1).
- **Consecuencias:** la medición sigue siendo obligatoria para cerrar la fase 1, pero ya no bloquea el diseño. En el peor caso se pierde la comodidad de Workers gratis, no el costo cero ni la verificación.

### ADR-15 · Torrent con web seeds como vía principal; IPFS sin servicios de fijado
- **Contexto:** los servicios gratuitos de fijado IPFS cambian de condiciones o cierran (Q-7).
- **Decisión:** ningún servicio de fijado forma parte del diseño. La vía principal de todo artefacto es el torrent con web seeds (DIST-3); el CID de IPFS se publica igualmente (DIST-1) y lo fijan el nodo del archivista y los de voluntarios.
- **Consecuencias:** un CID puede dejar de resolverse sin que el artefacto se pierda. Quien quiera usar un servicio de fijado puede hacerlo como un espejo más.

### ADR-16 · Sin escritura por defecto en relays públicos generales
- **Contexto:** publicar en relays Nostr de propósito general suma copias, pero esos relays no validan esquemas ni tienen por qué conservar estos kinds (Q-8).
- **Decisión:** el SDK escribe por defecto solo en la lista semilla y en los relays de la definición `city` (REPL-6).
- **Consecuencias:** qué relays son "los de la ciudad" lo decide quien firma la definición `city`. ARCH-1 no cambia: un relay estándar sigue sirviendo, y cualquiera puede añadirlo a mano.

### ADR-17 · Geohash a precisión 4–6 en la v1
- **Contexto:** en zonas densas una celda de precisión 6 (~1,2 km × 0,6 km) puede contener muchas fuentes (Q-9).
- **Decisión:** EVT-3 no cambia. El recorte exacto se hace en el cliente (SDK-6), así que la precisión afecta al volumen descargado, no a la corrección.
- **Consecuencias:** añadir precisión 7 más adelante costaría una fila más por evento en el relay (`07`) y sería un cambio compatible para los lectores. Se revisará con datos del piloto, después de la v1.

### ADR-18 · Cierre de la v1.0 y priorización MoSCoW
- **Contexto:** la v0.1 mezclaba requisitos imprescindibles con deseables y dejaba diez preguntas abiertas.
- **Decisión:** la spec se cierra como v1.0 con todas las preguntas resueltas, y cada requisito recibe una prioridad de entrega en `11`.
- **Consecuencias:** las palabras DEBE/DEBERÍA/PUEDE siguen indicando conformidad; MoSCoW indica qué se construye primero. Cambiar un requisito o su prioridad exige un ADR nuevo.

### ADR-19 · Licencia Apache-2.0 para el código y la spec
- **Contexto:** el repositorio no tenía licencia, así que nadie podía reutilizarlo legalmente. La fase 5 pide que terceros (apps externas, municipios, fabricantes de sensores) integren el SDK y operen sus propios relays.
- **Decisión:** todo el repositorio, código y documentación, se publica bajo Apache-2.0 (`LICENSE`). Se prefiere a MIT por la concesión explícita de patentes, relevante en firmware IoT y en compras públicas, y a AGPL-3.0 porque el copyleft de red frenaría la adopción del SDK en apps de terceros sin proteger nada que el protocolo abierto no proteja ya.
- **Consecuencias:** los datos no heredan esta licencia: cada `dataset` declara la suya (EVT, campo `license`) y el mapa base conserva la ODbL de OpenStreetMap con su atribución. `services/relay-strfry` usa la imagen de strfry (GPL-3.0) sin copiar su código; solo la configuración y la política de escritura de este repositorio son Apache-2.0.

### ADR-20 · Sin `TRUST_ANCHORS` no hay purga por antigüedad
- **Contexto:** RELAY-4 aceptaba como archivista a cualquier llave cuando el relay no tenía `TRUST_ANCHORS`, y los relays de referencia corren sin anclas mientras no haya custodios designados (Q-10). Cualquiera podía entonces publicar un `snapshot` que cubriera un día viejo, apuntar a un archivo propio del tamaño declarado e inflar `count`: el relay daba el día por archivado y borraba sus eventos reales, que ningún archivo legítimo respalda. Eso contradice GOAL-2 y el propósito de RELAY-4.
- **Decisión:** sin `TRUST_ANCHORS` ningún snapshot cuenta para la condición 1 de RELAY-4, así que el relay no purga por antigüedad; sigue borrando los eventos vencidos (NIP-40) y deja en el log el motivo. El ID RELAY-4 y su prioridad en `11` no cambian.
- **Consecuencias:** un relay sin anclas crece sin límite por antigüedad; si el almacenamiento se llena, rechaza escrituras (`restricted: storage full`) en lugar de borrar. Para purgar, el operador configura `TRUST_ANCHORS` con llaves que asignen el rol `archiver`. `RETENTION_DAYS` solo tiene efecto con anclas.

### ADR-21 · Los eventos con `expiration` no se archivan
- **Contexto:** el formato del archivo diario (`06`) no decía qué hacer con los eventos con `expiration` (NIP-40). La primera versión del archivista los incluía si aún no habían vencido al generar, así que el contenido, y con él `x`, dependía de cuándo corría cada archivista. Además, un evento que el autor marcó como temporal quedaba en un archivo permanente (torrent, IPFS, sello OTS) que ya no se puede retirar.
- **Decisión:** nuevo requisito SNAP-16: ningún evento con tag `expiration` válido entra en un snapshot, sea cual sea su fecha. El relay de referencia aplica la misma regla en `GET /v1/export`, y en el conteo de la condición 3 de RELAY-4. La purga por antigüedad sí los borra con su día archivado, aunque no hayan vencido: si no, una `expiration` lejana permitiría retener espacio para siempre sin archivo ni purga. Para que todas las implementaciones lean igual, solo cuenta el primer tag `expiration` escrito como entero decimal positivo estricto, y un borrado (kind 5) nunca caduca (DATA-8). La definición es una sola, `expirationOf` en `packages/schemas`.
- **Consecuencias:** el archivo es reproducible sin depender de la hora y respeta la intención del autor, en línea con el invariante 4 (sin datos personales en claro, ante la duda no conservar). Se pierde la historia de los datos temporales; si un kind necesita historia y caducidad a la vez, lo resolverá un ADR propio. Un evento con `expiration` puede desaparecer de un relay antes de vencer, al purgarse su día; es aceptable porque el autor ya lo declaró temporal. No se sube `v` del contenido `snapshot`: su esquema no cambia, solo qué eventos entran en el archivo, y la regla anterior solo existió en el código del archivista entre el PR #7 y este cambio, antes de publicar snapshots con él. Si algún snapshot se hubiera publicado con ella, no se reescribe (SNAP-2): una adenda o el consolidado mensual siguientes ya aplican SNAP-16.

## Propuestas evaluadas y descartadas

Registradas para no volver a discutirlas sin información nueva. Provienen de una revisión externa de la v0.1.

| Propuesta | Por qué no |
|---|---|
| Reducir la tolerancia de fecha futura (DATA-4) a 1 minuto | El riesgo que buscaba cubrir no existe: la pubkey forma parte de la dirección de un direccionable, así que una fecha adelantada solo afecta a los eventos del propio autor. Un margen de 1 minuto sí rechazaría dispositivos con reloj impreciso. |
| Campo `seq` para desempatar eventos `state` | Los relays Nostr estándar resuelven el reemplazo por `created_at` (ARCH-1); un `seq` en el contenido no cambiaría qué versión conservan. |
| Aceptar eventos con `202` y verificar firmas después en una cola | Rompe RELAY-1 y la respuesta `OK` de NIP-01, y no reduce el CPU total. El costo es una firma por evento, sin importar cuántas lecturas agrupe, y el límite de tasa ya precede a la verificación (RELAY-3). El riesgo de CPU se resuelve midiendo, con el orden de alternativas de ADR-14. |
| Verificar firmas por muestreo en el relay y dejar la verificación completa al cliente | Contradice RELAY-1 y el invariante de que relays y clientes verifican siempre. Ver ADR-14. |
| Llaves de respaldo con bloqueo temporal para las raíces | Sin consenso global no hay quién haga cumplir un plazo, y "inactividad" es falsificable ocultando eventos (TRUST-9). La recuperación es manual (`04`). |
| Empaquetar obligatoriamente los adjuntos en el consolidado mensual | Ver ADR-10. |
| Detectar y rechazar Base64 dentro de `content` | Heurística frágil con falsos positivos. Se acotó la longitud de los textos (EVT-9), que logra lo mismo. |

## Preguntas cerradas

Todas las preguntas abiertas de la v0.1 quedaron resueltas el 2026-10-12 al cerrar la v1.0. Los IDs se conservan porque otros documentos los citan. No quedan preguntas abiertas; una nueva toma el siguiente número libre (`Q-11`).

| ID | Pregunta | Resolución | Dónde queda |
|---|---|---|---|
| Q-1 | ¿Los kinds 1480–1483, 21480 y 31480–31486 chocan con kinds ya usados en Nostr? | No hay choque en el registro oficial. Los números quedan asignados | ADR-12 |
| Q-2 | ¿Rotación de raíces por mayoría simple o firma de umbral (FROST)? | Mayoría estricta. FROST queda fuera de la v1 | ADR-13, TRUST-12 |
| Q-3 | ¿Habrá funciones que exijan orden global (votación, fondos)? | No en la v1. Si llegan, son un módulo aparte sobre una L2 | `11`, Won't |
| Q-4 | ¿Agregados columnares (Parquet) por dataset además del NDJSON? | Sí, como artefacto derivado y reproducible desde el NDJSON, después de la v1 | `11`, Won't |
| Q-5 | ¿Un hub por relay o uno por ciudad? | Uno solo en la v1. Partir por ciudad es un cambio interno del relay que no toca el protocolo; se hará solo si la medición de la fase 1 muestra que un hub no sostiene la carga del piloto | `07`; `11`, Won't |
| Q-6 | ¿La verificación Schnorr cabe en el límite de CPU de la capa gratuita de Workers? | La verificación es siempre completa y previa a la escritura. Queda fijado el orden de alternativas; la medición es criterio de salida de la fase 1, no una pregunta de diseño | ADR-14 |
| Q-7 | ¿Qué servicios de fijado IPFS gratuitos son estables hoy? | No se depende de ninguno: torrent con web seeds es la vía principal; el CID lo fijan los nodos del archivista y de voluntarios | ADR-15 |
| Q-8 | ¿Publicar reportes en relays Nostr públicos generales ayuda a la resiliencia o solo atrae spam? | Por defecto no se publica en ellos | ADR-16, REPL-6 |
| Q-9 | ¿Precisión geohash 4–6 es suficiente para zonas densas, o hace falta 7? | La v1 se queda en 4–6 | ADR-17 |
| Q-10 | ¿Quién custodia las llaves raíz de la ciudad piloto? | La spec fija la regla (TRUST-11): al menos tres custodios de organizaciones distintas. Designarlos es un paso operativo de la fase 2, no una decisión de diseño | `04`, `09` |

## Glosario

| Término | Significado |
|---|---|
| Evento | Mensaje JSON firmado; unidad de datos del sistema |
| Kind | Número que indica el tipo de evento |
| Relay | Servidor que almacena y retransmite eventos |
| Direccionable | Evento del que solo se conserva la última versión por `(kind, pubkey, d)` |
| Ancla de confianza | Pubkey a la que un cliente le cree sobre los roles de una ciudad |
| Snapshot | Archivo con todos los eventos de una ciudad en un día |
| Archivista | Quien genera y publica snapshots |
| Geohash | Codificación de una celda geográfica como texto; prefijos más cortos son celdas mayores |
| OTS | OpenTimestamps: prueba de que un hash existía antes de cierto bloque de Bitcoin |
| CID | Identificador de contenido en IPFS |
| Web seed | URL HTTP que actúa como fuente de un torrent |
| PMTiles | Formato de mapa de teselas en un solo archivo |
| NIP | Documento de especificación del protocolo Nostr |
