# 00 · Visión y alcance

## Problema

Las plataformas smart city suelen ser un servidor municipal o de un proveedor. Cuando se acaba el contrato, el presupuesto o el interés político, los datos y las apps desaparecen. Además, terceros (vecinos, universidades, startups) no pueden aportar datos sin permiso.

## Visión

Una infraestructura de datos urbanos que:

- **no tiene dueño ni punto único de falla**: sigue viva mientras exista al menos un nodo con copia;
- **es abierta para escribir y leer**: cualquier app o sensor puede conectarse con una llave criptográfica, sin registro;
- **es verificable**: cada dato dice quién lo firmó y cuándo, y nadie puede alterarlo después;
- **cuesta cero** operar en su forma básica.

## Objetivos

| ID | Objetivo |
|---|---|
| GOAL-1 | Cualquier app puede publicar y consultar datos usando solo una librería cliente y un par de llaves. |
| GOAL-2 | Los datos sobreviven a la caída de cualquier relay, proveedor o del equipo fundador. |
| GOAL-3 | La app web sobrevive a la caída de su hosting: se puede obtener por torrent/IPFS y ejecutarse localmente. |
| GOAL-4 | La autenticidad e integridad de cada dato se verifica en el cliente, sin confiar en la infraestructura. |
| GOAL-5 | Todo el núcleo opera en capas gratuitas (Cloudflare Workers/Pages, Vercel, Netlify) o hardware doméstico. |
| GOAL-6 | Una ciudad nueva se da de alta publicando un evento, sin desplegar nada. |
| GOAL-7 | La app funciona sin conexión y sincroniza al reconectar. |

## No-objetivos

- **Pagos, tokens o criptomoneda.** No hay activo escaso que requiera consenso global.
- **Datos personales o expedientes ciudadanos.** El sistema es para datos públicos urbanos.
- **Control de actuadores críticos** (semáforos, válvulas). Es una capa de datos, no SCADA.
- **Tiempo real duro.** La latencia objetivo es de segundos, no de milisegundos.
- **Orden total global de eventos.** Basta consistencia eventual (ver `02`).
- **Garantía absoluta de permanencia.** Un torrent sin seeders muere; la spec minimiza ese riesgo, no lo elimina.

## Actores

| Actor | Descripción | Llave |
|---|---|---|
| Ciudadano | Usa la app, lee datos, envía reportes | Generada en el navegador o extensión NIP-07 |
| App | Software de terceros que publica o consume datos | Una llave por app |
| Fuente | Sensor, gateway IoT o proceso que publica observaciones | Una llave por dispositivo o por gateway |
| Operador de relay | Almacena y sirve eventos | Opcional (identifica al relay) |
| Archivista | Genera snapshots y los siembra por torrent/IPFS | Una llave por archivista |
| Autoridad | Llave(s) reconocidas de una ciudad que atestiguan roles | Llaves raíz de la ciudad |

Cualquier persona puede asumir cualquier rol. "Autoridad" no es un privilegio técnico: es una llave en la que los clientes deciden confiar (ver `04`).

## Casos de uso de referencia

1. **Calidad del aire comunitaria.** Vecinos con sensores ESP32 publican PM2.5 cada 5 min; la app muestra un mapa y series históricas.
2. **Reportes ciudadanos.** Bache, luminaria apagada, fuga: foto + ubicación + categoría. La autoridad o cualquier app publica cambios de estado.
3. **Transporte público en vivo.** Posiciones de autobuses como eventos efímeros; horarios como estado reemplazable.
4. **Estado de infraestructura.** Ocupación de estacionamientos, nivel de contenedores, estaciones de bici: "último valor gana".
5. **Datos abiertos reproducibles.** Un investigador descarga por torrent el snapshot de un año y verifica firmas y sello de tiempo sin pedir permiso.

Estos cinco casos fijan los requisitos de la v1; los esquemas correspondientes están en `03`.

## Requisitos no funcionales

| ID | Requisito |
|---|---|
| NFR-1 | Publicar un evento y verlo en otro cliente conectado: p95 < 3 s con al menos un relay común. |
| NFR-2 | La app carga (shell + mapa) con < 500 KB de JS comprimido en la primera visita. |
| NFR-3 | Con todos los relays caídos, la app sigue mostrando los datos locales y encola escrituras. |
| NFR-4 | Reconstruir un relay vacío desde snapshots no requiere contactar a ningún relay existente. |
| NFR-5 | Un evento DEBE caber en 64 KB serializado. |
