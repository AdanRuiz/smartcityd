# 09 · Roadmap

Fases incrementales. Cada una termina con algo desplegado y verificable. No se estiman fechas.

Las fases dicen **cuándo**; la prioridad de cada entregable (Must, Should, Could, Won't) está en `11`. Dentro de una fase se construye primero lo Must, y una fase se da por hecha cuando se cumplen sus criterios sobre lo Must; lo Should y lo Could que no entren pasan a la fase siguiente sin bloquearla.

## Fase 0 · Cimientos

- Monorepo pnpm, TypeScript estricto, CI (lint, test, build).
- `packages/schemas`: constantes de kinds (`10`, ADR-12), JSON Schemas de `03`, tipos generados, validadores.

**Hecho cuando:** los ejemplos de `03` pasan validación en tests y los contraejemplos fallan.

## Fase 1 · Relay mínimo y prueba de capacidad

- `services/relay-worker`: WebSocket NIP-01, D1, aceptación (pasos 1–7 de `07`), `POST`/`GET /v1/events`, NIP-11.
- Script de carga que publica observaciones agrupadas.

**Hecho cuando:** pasan las pruebas de aceptación 1–6 y 9 de `07`, y hay una medición real de CPU por evento y filas escritas por evento en la capa gratuita. Si la verificación de firma no cabe en el límite de CPU, se pasa a la siguiente alternativa del orden ya fijado (ver `10`, ADR-14) antes de seguir.

## Fase 2 · SDK y primer caso de uso de extremo a extremo

- `packages/sdk`: cliente, firmantes, pool de relays, validación, publicación y consulta de `dataset`, `source`, `observation`.
- `apps/web`: mapa (MapLibre + PMTiles), capa de un dataset, panel de relays.
- Designación de los custodios de las llaves raíz de la ciudad piloto (TRUST-11): al menos tres, de organizaciones distintas, con una llave guardada fuera de línea.
- Publicación manual de una ciudad piloto (`city`) y un dataset de calidad del aire.
- Despliegue en un espejo.

**Hecho cuando:** un sensor (real o simulado) publica y el punto aparece en el mapa de otra máquina en < 3 s (NFR-1) usando dos relays.

## Fase 3 · Offline, reportes y confianza

- IndexedDB, cola de salida, Service Worker (GOAL-7, NFR-3).
- Reportes ciudadanos con foto, `report_update`, llaves desechables (PRIV-5).
- Roles, niveles de confianza y filtros (`04`).
- Prueba de trabajo y límites de tasa en el relay.

**Hecho cuando:** se crea un reporte sin conexión y se sincroniza al reconectar; una llave con rol `authority` lo marca resuelto y otro cliente ve el estado oficial; un evento de llave `blocked` queda oculto.

## Fase 4 · Persistencia: snapshots y distribución de la app

- `services/archiver`: generación, publicación en IPFS y torrent, evento `snapshot`, sello OTS.
- `GET /v1/export`, retención condicionada (RELAY-4), importación de snapshots en el relay.
- Variante de archivo único de la app, evento `release`, espejos adicionales, magnet con web seeds.
- `sc.archive.read` y vista de series históricas.

**Hecho cuando:**
1. Un relay vacío se reconstruye solo desde snapshots (NFR-4).
2. `smartcity.html` descargado por torrent, abierto desde `file://` y sin el espejo principal disponible, muestra datos en vivo.
3. La prueba OTS de un snapshot verifica contra Bitcoin.

## Fase 5 · Apertura a terceros

- Estado y tiempo real: `state`, `live`; caso de transporte y de estacionamientos.
- `services/gateway-worker` y firmware de ejemplo para ESP32.
- Directorio de apps y datasets en la app; documentación para desarrolladores.
- Espejo entre relays (`MIRROR_FROM`), segundo relay con otro software.
- Rotación de raíces por mayoría.

**Hecho cuando:** una app externa, escrita solo con la documentación pública, publica un dataset nuevo y lo consume sin cambios en este repositorio.

## Después de v1 (sin compromiso)

Es la lista Won't de `11`: fuera de la v1 por decisión, no por olvido.

- Agregados columnares en snapshots (Q-4).
- Sincronización navegador a navegador por WebRTC.
- Reconciliación de conjuntos entre relays (NIP-77).
- Datos privados entre partes con cifrado (NIP-44) para operadores.
- Módulo de participación con orden global (Q-3).
- Firma de umbral para las raíces (Q-2).
- Un hub por ciudad en el relay de referencia (Q-5).
- Geohash a precisión 7 (Q-9).
- Propuesta de un NIP propio (Q-1).
