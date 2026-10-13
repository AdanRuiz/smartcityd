# Evaluación de Arquitectura: SmartCity Descentralizado

A continuación se presenta el consolidado de las 10 vulnerabilidades y áreas de mejora detectadas en la especificación de la plataforma (v0.1).

## 1. Consistencia y manipulación del tiempo
* **Hallazgo:** La regla DATA-3 permite que gane el evento con mayor `created_at`. Aunque DATA-4 limita las fechas futuras a 15 minutos, un actor malicioso puede publicar un estado a 15 minutos en el futuro, invalidando todas las actualizaciones legítimas emitidas durante ese lapso temporal.
* **Mejora Propuesta:** Reducir la tolerancia de tiempo futuro (DATA-4) a 1 minuto máximo. Alternativamente, requerir un campo explícito de número de secuencia (`seq`) en el esquema de los eventos de estado (kind 31485) para desempatar conflictos sin depender exclusivamente del reloj del cliente.

## 2. Riesgo de bloqueo en llaves raíz (Autoridad)
* **Hallazgo:** El sistema confía en llaves raíz y exige una mayoría estricta para rotarlas. Si un gobierno municipal pierde acceso a la mayoría de sus llaves (por rotación de personal o mala gestión), la identidad oficial de la ciudad queda inoperable para siempre.
* **Mejora Propuesta:** Implementar un mecanismo de degradación controlada o llaves de respaldo en frío (time-locked) que puedan emitir una nueva definición `city` si las raíces principales no presentan actividad o rotación durante un periodo extendido.

## 3. Confianza excesiva en el Gateway IoT
* **Hallazgo:** El gateway IoT autentica a los dispositivos más simples mediante un token en texto plano (`Bearer`) y firma los eventos con la llave del gateway. Si el gateway es vulnerado, un atacante tiene acceso directo para falsear lecturas en nombre de cualquier fuente conectada.
* **Mejora Propuesta:** Exigir que los microcontroladores (incluso los de 8 bits) calculen un HMAC ligero del payload utilizando un secreto compartido. El gateway validaría este HMAC antes de generar la firma Schnorr, previniendo ataques de inyección si la red interna es vulnerada.

## 4. Brecha de retención entre planos de almacenamiento
* **Hallazgo:** Existe una ventana donde un relay podría purgar eventos por límite de almacenamiento en su plano caliente antes de que el archivista haya completado y distribuido exitosamente el snapshot por IPFS/Torrent en el plano frío, perdiendo los datos.
* **Mejora Propuesta:** Establecer una regla arquitectónica donde un relay de referencia no purgue ningún dato regular (kinds 1000-9999) a menos que haya verificado la existencia de un snapshot consolidado y disponible en la red fría que cubra ese periodo temporal.

## 5. Prevención de abuso en adjuntos
* **Hallazgo:** Un usuario malicioso o una app mal diseñada podría abusar de los campos de texto libre (como el `body` de un `report`) inyectando cadenas Base64 o SVG masivos, saturando el límite de 64 KB por evento y abusando del almacenamiento gratuito.
* **Mejora Propuesta:** Añadir validación estricta en el SDK y relays de referencia que rechace cadenas con codificación binaria dentro del campo `content` o restringir la longitud máxima de cualquier valor tipo `string` dentro del array `values` de los esquemas de sensores.

## 6. Sincronización tardía y costo asintótico de adendas
* **Hallazgo:** La especificación no impone un límite para la antigüedad de los eventos aceptados por los relays. Esto obliga al archivista a escanear hasta 90 días de historial diariamente para encontrar eventos tardíos de clientes offline, agotando rápidamente la cuota de ~5 millones de lecturas diarias en la capa gratuita de Cloudflare D1.
* **Mejora Propuesta:** Establecer un límite máximo en el relay para la antigüedad de los eventos aceptados (por ejemplo, rechazar escrituras con un `created_at` anterior a 7 días). Esto acota drásticamente la ventana de búsqueda del archivista.

## 7. Riesgo de ejecución en la capa gratuita (Límite de CPU)
* **Hallazgo:** La validación de firmas Schnorr consume mucha CPU. Si un relay recibe una observación agrupada masiva o sufre un ataque DoS con firmas inválidas, la petición superará el estricto límite gratuito de ~10 ms de CPU por petición de Cloudflare Workers.
* **Mejora Propuesta:** Definir una estrategia asíncrona donde el Worker encole los eventos recibidos sin verificar la firma (retornando un HTTP 202 Accepted) y utilice Durable Objects o Queue Workers para validar las firmas en lotes fuera del hilo principal de la petición.

## 8. Volatilidad de los archivos adjuntos
* **Hallazgo:** Los archivos adjuntos (como las fotografías de reportes) se almacenan de forma externa (ej. Cloudflare R2) y se referencian por hash. Si el operador cierra la cuenta o borra el archivo, la URL muere y el registro inmutable apuntará a un archivo irrecuperable.
* **Mejora Propuesta:** Exigir que los archivistas consoliden no solo los eventos NDJSON, sino también todos los blobs adjuntos referenciados en ese periodo, empaquetándolos obligatoriamente en el torrent mensual consolidado (regla SNAP-4) para garantizar el almacenamiento frío.

## 9. Evicción silenciosa de almacenamiento local
* **Hallazgo:** La SPA depende de IndexedDB. Los sistemas operativos móviles borran IndexedDB sin avisar cuando el dispositivo se queda sin espacio. Esto haría que los usuarios pierdan su llave no exportada y cualquier reporte en cola offline.
* **Mejora Propuesta:** Requerir que el SDK utilice la API `navigator.storage.persist()` de HTML5. Esto solicita al navegador que marque el almacenamiento como persistente, protegiendo las llaves y la cola offline de la limpieza automática del sistema operativo.

## 10. Impacto del Proof of Work (PoW) en clientes móviles
* **Hallazgo:** El relay exige un Proof of Work de 16 bits (`POW_BITS_REPORT`) a llaves sin rol. Dado que la SPA carece de backend, calcular este PoW en el hilo principal del navegador congelará la interfaz en teléfonos móviles de gama baja.
* **Mejora Propuesta:** Especificar explícitamente en las reglas del SDK (SPAM-1) que cualquier resolución obligatoria de PoW debe ejecutarse utilizando la API de *Web Workers*, aislando el cálculo criptográfico del hilo de renderizado de React.