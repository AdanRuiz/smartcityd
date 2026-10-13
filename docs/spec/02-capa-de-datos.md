# 02 · Capa de datos (la "base de datos descentralizada")

## Respuesta corta

**No usar una blockchain como base de datos.** Usar un **registro de eventos firmados** replicado en relays independientes, con **archivo frío en torrent/IPFS** y la cadena de Bitcoin solo como **notario de fechas** mediante OpenTimestamps.

## Por qué no "chain"

Una blockchain resuelve un problema concreto: que desconocidos se pongan de acuerdo en **un orden único** de transacciones para evitar el doble gasto. Eso tiene un precio, y este sistema no necesita lo que compra.

| Necesidad real del sistema | ¿Requiere consenso global? | Cómo se resuelve aquí |
|---|---|---|
| Saber quién publicó un dato | No | Firma digital del autor |
| Que nadie lo altere | No | El `id` es el hash del contenido |
| Que no se pierda | No | Réplica en varios relays + snapshots |
| Probar que existía en cierta fecha | Solo un ancla | OpenTimestamps |
| Decidir cuál es el valor vigente | No | Regla determinista "el más reciente gana" |

Inconvenientes concretos de escribir datos urbanos en una cadena:

- **Costo.** Cada escritura paga comisión. Un sensor cada 5 minutos son 288 transacciones al día; incompatible con costo cero.
- **Volumen.** Las cadenas públicas manejan decenas de transacciones por segundo compartidas con todo el mundo.
- **Borrado imposible.** Si se cuela un dato personal o ilegal, no se puede retirar. Con relays, cada operador puede borrar.
- **Dependencia.** El sistema quedaría atado a la salud, gobernanza y precio de un token ajeno.
- **Fricción.** Cada app y sensor necesitaría una wallet con saldo.

Una cadena propia (PoA entre instituciones de la ciudad) elimina el costo pero reintroduce un grupo cerrado de validadores que hay que coordinar y mantener: más complejidad operativa que relays, sin beneficio para estos datos.

### Cuándo sí reconsiderarlo
Si en el futuro se añaden **presupuestos participativos con fondos, votaciones vinculantes o créditos transferibles**, eso sí necesita orden global y sería un módulo aparte sobre una L2. Queda fuera de la v1 (ver `10`, Q-3).

## Alternativas evaluadas

| Opción | A favor | En contra | Veredicto |
|---|---|---|---|
| Blockchain L1/L2 | Orden global, permanencia | Costo, volumen, sin borrado, wallet obligatoria | Solo como ancla de tiempo |
| Arweave / Filecoin | Permanencia pagada | No es gratis | Opcional para archivistas con presupuesto |
| IPFS + OrbitDB | CRDT sobre IPFS, P2P puro | Peers de navegador inestables, rendimiento pobre con muchos registros, ecosistema pequeño | Descartado para el núcleo |
| GunDB | Muy simple, P2P | Modelo de seguridad y consistencia difícil de auditar | Descartado |
| Hypercore / Holepunch | Logs firmados eficientes | Soporte débil en navegador, requiere peers siempre encendidos | Descartado para v1 |
| Ceramic / ComposeDB | Streams con esquema | Requiere nodos pesados, anclaje en Ethereum | Descartado |
| **Eventos firmados + relays (Nostr)** | Trivial de implementar, verificable en cliente, corre en Workers gratis, librerías y relays ya existentes | Sin orden global, la disponibilidad depende de que alguien opere relays | **Elegido** |

## Modelo

### Evento
Unidad mínima de datos. Estructura NIP-01:

```json
{
  "id": "<sha256 hex de la serialización canónica>",
  "pubkey": "<llave pública del autor, hex 32 bytes>",
  "created_at": 1760000000,
  "kind": 1480,
  "tags": [["c", "mx-gdl"], ["g", "9ewmq"]],
  "content": "<string; en este sistema siempre JSON>",
  "sig": "<firma Schnorr BIP-340 del id>"
}
```

`id = sha256(JSON.stringify([0, pubkey, created_at, kind, tags, content]))` sin espacios, UTF-8.

### Clases de evento

| Clase | Rango de kind | Semántica | Uso |
|---|---|---|---|
| Regular | 1000–9999 | Inmutable, se guarda todo | Observaciones, reportes, snapshots |
| Efímero | 20000–29999 | Se retransmite, no se guarda | Posiciones en vivo |
| Direccionable | 30000–39999 | Se guarda solo el último por `(kind, pubkey, d)` | Definiciones y estado actual |

### Reglas de datos

| ID | Regla |
|---|---|
| DATA-1 | Todo evento DEBE verificarse (`id` y `sig`) antes de almacenarse, retransmitirse o mostrarse. |
| DATA-2 | Los eventos regulares son inmutables. Una corrección es un evento nuevo que referencia al anterior con tag `e`. |
| DATA-3 | En eventos direccionables gana el de mayor `created_at`; en empate, el de `id` lexicográficamente menor. |
| DATA-4 | Un receptor DEBE rechazar eventos con `created_at` más de 15 minutos en el futuro. |
| DATA-5 | El `content` DEBE ser JSON válido con campo entero `v` (versión del esquema) conforme a `03`. |
| DATA-6 | Los clientes DEBEN deduplicar por `id`. Recibir el mismo evento de varios relays es normal. |
| DATA-7 | Los datos derivados (promedios, agregados, índices) NO son eventos de primera clase: se recalculan en el cliente o se publican como dataset aparte que cita sus fuentes. |
| DATA-12 | Un relay PUEDE rechazar eventos regulares con `created_at` más antiguo que un máximo que declara en su NIP-11 (RELAY-5). Los direccionables no tienen límite de antigüedad. |
| DATA-8 | El borrado se solicita con un evento kind 5 (NIP-09) del mismo autor. Los relays DEBERÍAN honrarlo; los snapshots ya publicados no se reescriben (ver `08`). |

### Consistencia

**Eventual, sin orden global.** Dos clientes conectados a relays distintos pueden ver conjuntos distintos durante un tiempo; convergen al unir lo que ven, porque:

- los eventos regulares forman un conjunto que solo crece (la unión es conmutativa);
- los direccionables se resuelven con DATA-3, que da el mismo resultado sin importar el orden de llegada.

`created_at` lo fija el autor y **puede mentir**. Consecuencias aceptadas:

- No usarlo como prueba de fecha: para eso está el sello OpenTimestamps del snapshot.
- Un autor puede "ganar" DATA-3 poniendo una fecha futura, pero solo sobre **sus propios** eventos direccionables (la llave forma parte de la dirección), y DATA-4 lo acota a 15 minutos.

### Replicación

| ID | Regla |
|---|---|
| REPL-1 | El cliente publica cada evento en al menos 3 relays cuando hay 3 disponibles. |
| REPL-2 | El cliente lee de al menos 2 relays y une los resultados. |
| REPL-3 | Los relays PUEDEN espejarse entre sí suscribiéndose a los kinds del sistema, o con reconciliación de conjuntos (NIP-77 negentropy) si ambos la soportan. |
| REPL-4 | La lista de relays de una ciudad vive en su evento de definición (kind 31480); cada autor PUEDE publicar la suya (kind 10002, NIP-65). |
| REPL-5 | La app incluye una lista semilla de relays en el build, editable por el usuario. |
| REPL-6 | Por defecto el SDK escribe solo en la lista semilla y en los `relays` de la definición `city`. NO DEBE añadir por su cuenta relays Nostr públicos de propósito general; el usuario o la app PUEDEN añadirlos de forma explícita. |

### Planos de almacenamiento

| Plano | Retención | Consulta | Costo |
|---|---|---|---|
| Local (IndexedDB) | Lo que el usuario ha visto; tope configurable (por defecto 50 MB) | Instantánea, offline | 0 |
| Caliente (relays) | Ventana que decida cada operador (sugerido 90 días para kinds regulares; indefinido para direccionables) | Filtros en vivo | Capa gratuita |
| Frío (snapshots) | Indefinida mientras haya seeders | Descarga y proceso en cliente | 0 (ancho de banda de voluntarios) |

El plano frío hace que la retención limitada de los relays gratuitos no sea pérdida de datos.

### Volumen y agrupación

Las capas gratuitas limitan escrituras por día (ver `07`). Por eso:

- DATA-9: Una fuente con frecuencia mayor a una lectura por minuto DEBERÍA agrupar varias lecturas en un solo evento de observación (hasta 500 lecturas o 64 KB).
- DATA-10: Las posiciones en vivo y demás datos de valor instantáneo DEBEN ir como efímeros (kind 21480), no como regulares.
- DATA-11: Los binarios (fotos) NO van dentro del evento. Se suben a almacenamiento direccionado por contenido y el evento lleva hash y URLs (ver `03`, adjuntos).
