# 04 · Identidad y confianza

## Principio

**Escribir es libre; confiar es decisión del lector.** No existe un servidor que autorice. Cualquier llave puede publicar; cada cliente decide qué mostrar y cómo etiquetarlo según a quién le cree.

## Identidad

- Una identidad es un par de llaves secp256k1. La pública (32 bytes hex, o `npub…` en formato legible) es el identificador.
- No hay registro, correo ni contraseña.

| ID | Regla |
|---|---|
| ID-1 | La app web DEBE soportar firmante por extensión del navegador (NIP-07) y llave local generada en el dispositivo. |
| ID-2 | Una llave local se guarda cifrada con una frase del usuario (NIP-49) o como `CryptoKey` no exportable; nunca en claro en `localStorage`. |
| ID-3 | Para leer no se requiere llave. |
| ID-4 | Cada app, gateway y archivista usa su propia llave; no se comparten llaves entre roles. |
| ID-5 | Un dispositivo capaz de firmar (ESP32 y superiores) DEBERÍA tener llave propia, listada en `keys` de su `source`. |
| ID-6 | La app DEBE ofrecer exportar la llave y advertir que perderla es irrecuperable. |
| ID-7 | Al crear una llave local estable, la app pide almacenamiento persistente (SDK-11) y, si el navegador lo niega, lo indica y recomienda exportar la llave en ese momento: el sistema operativo puede borrar el almacenamiento del navegador sin avisar. |

### Pérdida o robo de llave
No hay recuperación. Mitigaciones:

- Fuentes y apps: el dueño publica un nuevo `source`/`app` con otra llave y marca el anterior `retired`.
- Llave atestiguada: la autoridad publica una nueva lista `roles` sin ella (o con rol `blocked`).
- Llave raíz de una ciudad: ver "Rotación de raíces".

## Anclas de confianza

Un **ancla** es una pubkey en la que el cliente confía para decir quién es quién en una ciudad. Por defecto, las anclas de una ciudad son las llaves `roots` de la definición `city` que el cliente tiene fijada.

| ID | Regla |
|---|---|
| TRUST-1 | El build de la app incluye, por cada ciudad preconfigurada, su `city id` y sus pubkeys raíz. Ese es el punto de partida de la confianza. |
| TRUST-2 | El usuario PUEDE añadir o quitar anclas y cambiar de definición de ciudad desde la app. |
| TRUST-3 | Para una ciudad no preconfigurada, la app muestra las definiciones `city` existentes con ese `d`, quién las firma, y deja elegir. Nunca elige sola. |
| TRUST-4 | Las listas `roles` (kind 31484) solo cuentan si las firma un ancla del cliente. |

## Roles

| Rol | Significado | Efecto en el cliente |
|---|---|---|
| `authority` | Habla por la ciudad | Sus `report_update` fijan el estado oficial; puede definir datasets "oficiales" |
| `operator` | Entidad que opera servicios urbanos | Sus `report_update` fijan estado; sus datos se marcan verificados |
| `source` | Fuente de datos reconocida | Sus observaciones se marcan verificadas |
| `app` | App reconocida | Los eventos publicados por ella se marcan verificados |
| `archiver` | Archivista reconocido | Sus snapshots se prefieren |
| `moderator` | Puede etiquetar contenido | Sus etiquetas (kind 1985) y denuncias (1984) ocultan contenido por defecto |
| `blocked` | Llave vetada | Sus eventos se ocultan por defecto |

## Niveles de confianza al leer

Todo evento verificado criptográficamente recibe un nivel calculado en el cliente:

| Nivel | Condición | Presentación por defecto |
|---|---|---|
| `verified` | El autor tiene rol atestiguado por un ancla, o firma con una llave listada en `keys` de un `source` cuyo dueño lo tiene | Visible, con distintivo |
| `community` | Firma válida, sin atestación | Visible, sin distintivo |
| `flagged` | Autor `blocked`, o evento etiquetado por un `moderator` | Oculto; visible si el usuario lo pide |

| ID | Regla |
|---|---|
| TRUST-5 | La app DEBE permitir filtrar cada capa por nivel de confianza. |
| TRUST-6 | Los agregados (promedios en el mapa) usan solo `verified` por defecto cuando el dataset tiene fuentes verificadas; si no las tiene, usan `community`. La app indica cuál se está usando. |
| TRUST-7 | El nivel nunca se guarda dentro del evento ni lo decide un relay; se recalcula cuando cambian las anclas o las listas de roles. |

## Rotación de raíces

| ID | Regla |
|---|---|
| TRUST-11 | Una ciudad DEBERÍA tener al menos 3 llaves raíz en manos de personas o instituciones distintas. |
| TRUST-12 | Añadir o quitar una raíz se hace publicando una nueva definición `city`. El cliente la acepta automáticamente solo si llega firmada, con el mismo contenido, por una **mayoría estricta de las raíces que ya conoce**. Si no, la muestra como propuesta pendiente de decisión del usuario. |

Como cada raíz publica su propio evento direccionable (la pubkey forma parte de la dirección), "misma definición" significa mismo `content` byte a byte.

Esto es deliberadamente simple. Un esquema de umbral criptográfico (FROST, multisig) queda fuera de la v1 (`10`, ADR-13).

### Recuperación si se pierde la mayoría de las raíces

Perder la mayoría impide la rotación **automática**, no la identidad de la ciudad. Como la confianza la decide el lector, hay dos caminos de recuperación, ambos manuales a propósito:

1. **Nueva versión de la app.** Los custodios publican por canales fuera del sistema (sitio oficial, gaceta, prensa) las nuevas pubkeys raíz; los desarrolladores de cada app las embeben en un `release` nuevo (TRUST-1).
2. **Aceptación manual.** La nueva definición `city` aparece en la app como propuesta pendiente (TRUST-3) y el usuario la acepta tras comprobar las pubkeys por un canal externo.

| ID | Regla |
|---|---|
| TRUST-8 | La app DEBE mostrar la huella de las raíces vigentes y de las propuestas de forma comparable (formato `npub` y código QR) para facilitar la comprobación externa. |
| TRUST-9 | No existe mecanismo que reemplace raíces por inactividad o por paso del tiempo: sin consenso global no hay forma de hacerlo cumplir, y sería una vía de secuestro para quien logre ocultar eventos. |
| TRUST-10 | Las atestaciones `roles` ya emitidas por las raíces anteriores dejan de contar cuando el cliente cambia de anclas; las nuevas raíces DEBEN volver a publicarlas. |

Recomendación operativa: custodios en instituciones distintas, y al menos una raíz guardada fuera de línea que no dependa de quién ocupe un cargo.

## Anti-spam y abuso

No hay barrera económica, así que las defensas son por capas:

| Capa | Mecanismo |
|---|---|
| Relay | Límite de tasa por IP y por pubkey; tamaño máximo; validación de esquema; rechazo de `created_at` fuera de ventana |
| Relay | Prueba de trabajo (NIP-13) exigible a llaves sin rol: dificultad configurable, por defecto 16 bits para `report` |
| Relay | Política propia: un operador PUEDE aceptar solo llaves con rol, solo ciertas ciudades, etc. Lo declara en su documento NIP-11 |
| Cliente | Filtro por nivel de confianza; silenciar llaves localmente |
| Comunidad | Denuncias (kind 1984) y etiquetas de moderadores (kind 1985) |

| ID | Regla |
|---|---|
| SPAM-1 | El SDK calcula la prueba de trabajo automáticamente cuando el relay la exige (respuesta `OK false` con prefijo `pow:`). En navegador el cálculo corre en un Web Worker, nunca en el hilo de la interfaz, y es cancelable. |
| SPAM-2 | Un relay público de referencia DEBE aceptar al menos lecturas de cualquiera; restringir escritura es opción del operador, no valor por defecto. |
| SPAM-3 | Los datos de sensores comunitarios son falsificables por diseño. La app DEBERÍA ofrecer detección de valores atípicos respecto a fuentes vecinas y mostrarla, sin borrar nada. |

## Lo que la firma garantiza y lo que no

| Garantiza | No garantiza |
|---|---|
| Qué llave publicó el evento | Quién está detrás de la llave |
| Que no fue modificado | Que el dato sea verdadero |
| — | Que la fecha `created_at` sea real (para eso, OpenTimestamps) |
