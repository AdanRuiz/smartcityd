# 03 · Modelo de eventos (normativo)

Fuente de verdad de formatos. La estructura base del evento y sus clases están en `02`.

## Tabla de kinds

> Números **asignados para la v1**: comprobados sin colisión contra el registro de kinds de Nostr el 2026-10-12 (ver `10`, ADR-12). El código DEBE importarlos de `packages/schemas`, nunca escribirlos como literales.

| Kind | Nombre | Clase | Quién lo publica | Propósito |
|---|---|---|---|---|
| 31480 | `city` | Direccionable | Autoridad | Define una ciudad: nombre, límites, relays, llaves raíz |
| 31481 | `dataset` | Direccionable | Cualquiera | Declara un tipo de dato: campos, unidades, licencia |
| 31482 | `source` | Direccionable | Dueño de la fuente | Registra un sensor o proceso: ubicación, dataset |
| 31483 | `app` | Direccionable | Desarrollador | Ficha de una app: nombre, URL, datasets que usa |
| 31484 | `roles` | Direccionable | Autoridad o cualquiera | Lista de llaves con rol atestiguado |
| 31485 | `state` | Direccionable | Fuente | Estado vigente de una entidad (último gana) |
| 31486 | `release` | Direccionable | Desarrollador | Versión publicada de una app: CID, magnet, hash |
| 1480 | `observation` | Regular | Fuente | Una o varias lecturas con marca de tiempo |
| 1481 | `report` | Regular | Ciudadano / app | Reporte ciudadano georreferenciado |
| 1483 | `report_update` | Regular | Cualquiera | Cambio de estado o comentario sobre un reporte |
| 1482 | `snapshot` | Regular | Archivista | Anuncia un archivo de snapshot |
| 21480 | `live` | Efímero | Fuente | Telemetría instantánea (posiciones) |

Kinds de Nostr reutilizados tal cual: `5` borrado (NIP-09), `1040` sello OpenTimestamps (NIP-03), `1984` denuncia (NIP-56), `1985` etiqueta (NIP-32), `10002` lista de relays (NIP-65).

## Tags

Los relays solo indexan tags de una letra; por eso todo lo consultable usa una letra.

| Tag | Valor | Uso |
|---|---|---|
| `c` | ID de ciudad | Obligatorio en todo evento del sistema excepto `city` (que lo lleva en `d`) |
| `d` | Identificador | Obligatorio en direccionables |
| `a` | `<kind>:<pubkey>:<d>` | Referencia a un direccionable (dataset, source, city) |
| `e` | ID de evento | Referencia a un evento regular |
| `p` | Pubkey | Referencia a un autor |
| `g` | Geohash | Ubicación. Se repite a precisión 4, 5 y 6 para permitir consulta por zona |
| `t` | Texto en minúsculas | Categoría |
| `x` | sha256 hex | Hash de un archivo referido |
| `expiration` | Unix time | Caducidad (NIP-40) |

| ID | Regla |
|---|---|
| EVT-1 | **ID de ciudad**: `<país ISO 3166-1 alfa-2>-<slug>`, minúsculas, `[a-z0-9-]`, máx. 32 caracteres. Ej.: `mx-gdl`. |
| EVT-2 | **Dirección de dataset**: `31481:<pubkey>:<d>`. Dos autores pueden usar el mismo `d`; son datasets distintos. |
| EVT-3 | Todo evento georreferenciado DEBE llevar tres tags `g` (precisión 4, 5, 6) del mismo punto. La coordenada exacta, si se publica, va en `content`. |
| EVT-4 | Coordenadas en WGS84, orden `[lat, lon]`, máximo 6 decimales. |
| EVT-5 | Tiempos en segundos Unix (enteros). Zona horaria solo en la definición de ciudad. |
| EVT-6 | El `content` es un objeto JSON con `v` entero. Los receptores DEBEN ignorar campos desconocidos y rechazar un `v` mayor al que soportan solo si no pueden interpretar los campos obligatorios. |
| EVT-7 | Un relay de referencia DEBE rechazar eventos de estos kinds que no cumplan su esquema. Un cliente DEBE descartarlos aunque un relay los entregue. |

## Esquemas

Cada esquema vive en `packages/schemas/<nombre>.schema.json` (JSON Schema 2020-12). Aquí se describen los campos; **obl.** = obligatorio.

### 31480 · `city`

Tags: `["d", "<city id>"]`.

| Campo | Tipo | Obl. | Descripción |
|---|---|---|---|
| `v` | int | sí | `1` |
| `name` | string | sí | Nombre legible |
| `bbox` | `[minLat, minLon, maxLat, maxLon]` | sí | Límites |
| `tz` | string | sí | Zona IANA, ej. `America/Mexico_City` |
| `relays` | string[] | sí | URLs `wss://` recomendadas |
| `roots` | string[] | sí | Pubkeys de autoridad |
| `tiles` | `{x, cid?, magnet?, urls?}` | no | Archivo PMTiles de la ciudad |
| `about` | string | no | Descripción |

Cualquiera puede publicar un `city` con el mismo `d`. Cuál es "la" definición de una ciudad lo decide el cliente según sus anclas de confianza (ver `04`).

### 31481 · `dataset`

Tags: `["d", "<slug>"]`, `["c", "<city>"]` (o `["c", "*"]` si es reutilizable entre ciudades), `["t", "<categoría>"]`.

| Campo | Tipo | Obl. | Descripción |
|---|---|---|---|
| `v` | int | sí | `1` |
| `name` | string | sí | |
| `description` | string | no | |
| `license` | string | sí | Identificador SPDX, ej. `CC-BY-4.0`, `CC0-1.0` |
| `mode` | `"observation"` \| `"state"` \| `"live"` | sí | Qué kind transporta los datos |
| `fields` | objeto | sí | Mapa `nombre → {type, unit?, min?, max?, enum?, description?}`; `type` ∈ `number`, `integer`, `string`, `boolean` |
| `geometry` | `"point"` \| `"none"` | sí | |
| `cadence_s` | int | no | Periodo esperado entre lecturas |
| `model` | string (URL) | no | Modelo equivalente en Smart Data Models / NGSI-LD, para interoperar |

```json
{
  "kind": 31481,
  "tags": [["d", "air-quality"], ["c", "*"], ["t", "ambiente"]],
  "content": "{\"v\":1,\"name\":\"Calidad del aire\",\"license\":\"CC0-1.0\",\"mode\":\"observation\",\"geometry\":\"point\",\"cadence_s\":300,\"fields\":{\"pm25\":{\"type\":\"number\",\"unit\":\"ug/m3\",\"min\":0,\"max\":1000},\"pm10\":{\"type\":\"number\",\"unit\":\"ug/m3\",\"min\":0,\"max\":2000},\"temp\":{\"type\":\"number\",\"unit\":\"Cel\"},\"rh\":{\"type\":\"number\",\"unit\":\"%\",\"min\":0,\"max\":100}}}"
}
```

Unidades en notación UCUM cuando exista.

### 31482 · `source`

Tags: `["d", "<id de la fuente>"]`, `["c", "<city>"]`, `["a", "<dirección del dataset>"]`, tres `["g", …]` si es fija.

| Campo | Tipo | Obl. | Descripción |
|---|---|---|---|
| `v` | int | sí | `1` |
| `name` | string | sí | |
| `loc` | `[lat, lon]` | no | Ubicación fija |
| `elevation_m` | number | no | |
| `hardware` | string | no | Modelo del sensor |
| `status` | `"active"` \| `"retired"` | sí | |
| `keys` | string[] | no | Pubkeys de dispositivos autorizados a publicar en nombre de esta fuente (si no firman con la llave del dueño) |

### 1480 · `observation`

Tags: `["c", city]`, `["a", dataset]`, `["a", source]` (opcional pero recomendado), tres `["g", …]` si `geometry = point`.

| Campo | Tipo | Obl. | Descripción |
|---|---|---|---|
| `v` | int | sí | `1` |
| `loc` | `[lat, lon]` | no | Ubicación común a todas las lecturas |
| `obs` | array (1–500) | sí | Lecturas |
| `obs[].ts` | int | sí | Momento de la medición |
| `obs[].values` | objeto | sí | Mapa `campo → valor` según `fields` del dataset |
| `obs[].loc` | `[lat, lon]` | no | Si la fuente es móvil |
| `obs[].q` | `"ok"` \| `"suspect"` \| `"bad"` | no | Calidad autoevaluada; por defecto `ok` |

```json
{
  "kind": 1480,
  "created_at": 1760000300,
  "tags": [
    ["c", "mx-gdl"],
    ["a", "31481:9f3c…:air-quality"],
    ["a", "31482:4be1…:azotea-chapalita-01"],
    ["g", "9ewm"], ["g", "9ewmq"], ["g", "9ewmqx"]
  ],
  "content": "{\"v\":1,\"loc\":[20.6668,-103.3918],\"obs\":[{\"ts\":1760000000,\"values\":{\"pm25\":18.2,\"temp\":24.1}},{\"ts\":1760000300,\"values\":{\"pm25\":19.0,\"temp\":24.0}}]}"
}
```

Esquema del `content`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["v", "obs"],
  "properties": {
    "v": { "const": 1 },
    "loc": { "$ref": "#/$defs/latlon" },
    "obs": {
      "type": "array", "minItems": 1, "maxItems": 500,
      "items": {
        "type": "object",
        "required": ["ts", "values"],
        "properties": {
          "ts": { "type": "integer", "minimum": 0 },
          "values": {
            "type": "object", "minProperties": 1, "maxProperties": 64,
            "additionalProperties": { "type": ["number", "string", "boolean"], "maxLength": 256 }
          },
          "loc": { "$ref": "#/$defs/latlon" },
          "q": { "enum": ["ok", "suspect", "bad"] }
        }
      }
    }
  },
  "$defs": {
    "latlon": {
      "type": "array", "minItems": 2, "maxItems": 2,
      "prefixItems": [
        { "type": "number", "minimum": -90, "maximum": 90 },
        { "type": "number", "minimum": -180, "maximum": 180 }
      ]
    }
  }
}
```

EVT-8: Además del esquema, el SDK DEBE validar `values` contra los `fields` del dataset referido cuando lo tenga disponible. El relay PUEDE hacerlo.

EVT-9: En `values` (kinds 1480, 31485 y 21480) un valor de tipo texto mide como máximo 256 caracteres y el objeto tiene como máximo 64 campos. `values` es para mediciones y códigos cortos, no para texto libre ni binarios codificados; estos van como adjuntos (DATA-11). SDK y relay de referencia DEBEN rechazar lo que exceda.

### 31485 · `state`

Para datos donde solo importa el valor vigente (ocupación de un estacionamiento, horario de una ruta).

Tags: `["d", "<id de la entidad>"]`, `["c", city]`, `["a", dataset]`, tres `["g", …]` si aplica.

| Campo | Tipo | Obl. | Descripción |
|---|---|---|---|
| `v` | int | sí | `1` |
| `ts` | int | sí | Momento al que corresponde el estado |
| `values` | objeto | sí | Según `fields` del dataset |
| `loc` | `[lat, lon]` | no | |

Si además se quiere historial, la fuente publica también observaciones (kind 1480).

### 21480 · `live`

Mismo contenido que `state`. No se almacena. Tags: `["c", city]`, `["a", dataset]`, `["d", "<id de la entidad>"]`, tres `["g", …]`.

### 1481 · `report`

Tags: `["c", city]`, `["t", "<categoría>"]`, tres `["g", …]`.

| Campo | Tipo | Obl. | Descripción |
|---|---|---|---|
| `v` | int | sí | `1` |
| `title` | string (≤120) | sí | |
| `body` | string (≤2000) | no | |
| `loc` | `[lat, lon]` | sí | Ver PRIV-3 en `08` sobre precisión |
| `attachments` | array (≤4) | no | `{x, mime, size, urls[]}` |

Categorías iniciales (`t`): `bache`, `alumbrado`, `fuga`, `basura`, `semaforo`, `arbolado`, `otro`. Las apps PUEDEN usar otras.

### 1483 · `report_update`

Tags: `["c", city]`, `["e", "<id del reporte>"]`, `["p", "<autor del reporte>"]`.

| Campo | Tipo | Obl. | Descripción |
|---|---|---|---|
| `v` | int | sí | `1` |
| `status` | `"open"` \| `"ack"` \| `"in_progress"` \| `"resolved"` \| `"rejected"` \| `"duplicate"` | no | |
| `body` | string (≤2000) | no | |
| `attachments` | array (≤4) | no | |

DEBE llevar `status` o `body`. El estado vigente de un reporte es el `status` del `report_update` más reciente cuyo autor tenga rol `authority` u `operator` para la ciudad (ver `04`); si no hay ninguno, `open`. Las actualizaciones de otros autores se muestran como comentarios.

### Adjuntos

Objeto `{x, mime, size, urls}`: `x` es el sha256 del archivo; `urls` es una lista de ubicaciones (`https://…`, `ipfs://<cid>`). El cliente DEBE verificar el hash tras descargar. Tamaño máximo recomendado 2 MB; las fotos se redimensionan y se les quita el EXIF en el cliente antes de subir (PRIV-4).

### 31483 · `app`

Tags: `["d", "<slug>"]`, cero o más `["c", city]`, cero o más `["a", dataset]`.

Contenido: `{v, name, description?, urls[], icon?, repo?, writes[], reads[], automated?}` donde `writes`/`reads` son direcciones de dataset o números de kind, y `automated: true` declara que publica un agente o proceso sin intervención humana.

### 31484 · `roles`

Tags: `["d", "<city id>"]`, `["c", city]`, y un tag `p` por llave: `["p", "<pubkey>", "<rol>", "<nota opcional>"]`.

Roles: `authority`, `operator`, `app`, `source`, `archiver`, `moderator`, `blocked`. Contenido: `{v, about?}`. Semántica en `04`.

### 31486 · `release` y 1482 · `snapshot`

Definidos en `06`.

## Consultas típicas (filtros NIP-01)

```jsonc
// Calidad del aire en una zona, última hora
{ "kinds": [1480], "#c": ["mx-gdl"], "#a": ["31481:9f3c…:air-quality"], "#g": ["9ewmq"], "since": 1759996400 }

// Estado vigente de todos los estacionamientos
{ "kinds": [31485], "#c": ["mx-gdl"], "#a": ["31481:9f3c…:parking"] }

// Reportes abiertos recientes de una categoría
{ "kinds": [1481], "#c": ["mx-gdl"], "#t": ["bache"], "limit": 200 }

// Actualizaciones de un reporte
{ "kinds": [1483], "#e": ["<id del reporte>"] }

// Catálogo de datasets de la ciudad
{ "kinds": [31481], "#c": ["mx-gdl", "*"] }

// Snapshots disponibles
{ "kinds": [1482], "#c": ["mx-gdl"] }
```

Varios valores en un mismo tag son OR; tags distintos son AND. No hay consultas por rango geográfico arbitrario: se piden las celdas geohash que cubren el viewport y se recorta en el cliente.
