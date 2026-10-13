# 10 · Decisiones y preguntas abiertas

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

## Propuestas evaluadas y descartadas

Registradas para no volver a discutirlas sin información nueva. Provienen de una revisión externa de la v0.1.

| Propuesta | Por qué no |
|---|---|
| Reducir la tolerancia de fecha futura (DATA-4) a 1 minuto | El riesgo que buscaba cubrir no existe: la pubkey forma parte de la dirección de un direccionable, así que una fecha adelantada solo afecta a los eventos del propio autor. Un margen de 1 minuto sí rechazaría dispositivos con reloj impreciso. |
| Campo `seq` para desempatar eventos `state` | Los relays Nostr estándar resuelven el reemplazo por `created_at` (ARCH-1); un `seq` en el contenido no cambiaría qué versión conservan. |
| Aceptar eventos con `202` y verificar firmas después en una cola | Rompe RELAY-1 y la respuesta `OK` de NIP-01, y no reduce el CPU total. El costo es una firma por evento, sin importar cuántas lecturas agrupe, y el límite de tasa ya precede a la verificación (RELAY-3). El riesgo de CPU sigue abierto como Q-6 y se resuelve midiendo. |
| Llaves de respaldo con bloqueo temporal para las raíces | Sin consenso global no hay quién haga cumplir un plazo, y "inactividad" es falsificable ocultando eventos (TRUST-9). La recuperación es manual (`04`). |
| Empaquetar obligatoriamente los adjuntos en el consolidado mensual | Ver ADR-10. |
| Detectar y rechazar Base64 dentro de `content` | Heurística frágil con falsos positivos. Se acotó la longitud de los textos (EVT-9), que logra lo mismo. |

## Preguntas abiertas

| ID | Pregunta | Bloquea | Propuesta inicial |
|---|---|---|---|
| Q-1 | ¿Los kinds 1480–1483, 21480 y 31480–31486 chocan con kinds ya usados en Nostr? | Fase 0 | Revisar el registro de NIPs y relays públicos; mover el bloque si hay choque. Valorar proponer un NIP |
| Q-2 | ¿Rotación de raíces por mayoría simple o firma de umbral (FROST)? | Fase 5 | Mayoría simple en v1 |
| Q-3 | ¿Habrá funciones que exijan orden global (votación, fondos)? | Nada en v1 | Módulo separado sobre una L2 si llega el caso |
| Q-4 | ¿Agregados columnares (Parquet) por dataset además del NDJSON? | Post-v1 | Sí, como artefacto derivado y reproducible desde el NDJSON |
| Q-5 | ¿Un hub por relay o uno por ciudad? | Fase 1 (medición) | Uno solo hasta que las métricas pidan partir |
| Q-6 | ¿La verificación Schnorr cabe en el límite de CPU de la capa gratuita de Workers? | Fase 1 | Medir. Alternativas: verificación en WASM, o muestreo con verificación completa en cliente (el cliente verifica siempre de todos modos) |
| Q-7 | ¿Qué servicios de fijado IPFS gratuitos son estables hoy? | Fase 4 | No depender de ninguno: torrent con web seeds como vía principal, IPFS como secundaria |
| Q-8 | ¿Publicar reportes en relays Nostr públicos generales ayuda a la resiliencia o solo atrae spam? | Fase 3 | Empezar solo con relays que validen esquema |
| Q-9 | ¿Precisión geohash 4–6 es suficiente para zonas densas, o hace falta 7? | Fase 2 | Medir con datos reales del piloto |
| Q-10 | ¿Quién custodia las llaves raíz de la ciudad piloto? | Fase 2 | Tres custodios de organizaciones distintas |

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
