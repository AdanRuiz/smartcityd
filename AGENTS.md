# Guía para agentes de IA

Este repositorio contiene la especificación de un sistema smart city descentralizado. Lee esto antes de generar código o modificar la spec.

## Orden de lectura

1. `README.md` — resumen e índice.
2. `docs/spec/01-arquitectura.md` — componentes y estructura del repo.
3. `docs/spec/03-modelo-de-eventos.md` — **fuente de verdad** de kinds, tags y esquemas.
4. El documento específico de la tarea (relay → 07, SDK/app → 05, snapshots → 06).

## Convenciones de la spec

- **DEBE / NO DEBE / DEBERÍA / PUEDE** tienen el sentido de RFC 2119.
- Cada requisito lleva un identificador estable (`DATA-3`, `EVT-7`, `RELAY-2`…). Cítalo en commits, tests y comentarios de PR.
- Si dos documentos se contradicen, gana `03-modelo-de-eventos.md` para formatos y `10-decisiones.md` para el porqué.
- Los números de kind (`1480`–`1483`, `21480`, `31480`–`31486`) están asignados para la v1 (`10`, ADR-12), pero moverlos sigue siendo posible: no los escribas como literales dispersos; impórtalos de `packages/schemas`.
- **MoSCoW** (`11-priorizacion.md`) indica prioridad de entrega y es independiente de DEBE/DEBERÍA/PUEDE. Construye primero lo Must; no implementes nada Won't sin un ADR que lo cambie.

## Invariantes que no se negocian

1. **Ningún componente es obligatorio.** No introducir un servidor, dominio, cuenta o proveedor cuya caída detenga el sistema. Vercel, Netlify y Cloudflare son espejos y conveniencias, nunca dependencias.
2. **Todo dato es un evento firmado NIP-01.** Nada entra al sistema sin `id` y `sig` válidos. Los relays y clientes verifican siempre; nunca confían en el transporte.
3. **Los eventos regulares son inmutables.** Se corrige publicando otro evento, no editando.
4. **Sin datos personales en claro.** Ver `08-seguridad-y-privacidad.md` antes de añadir cualquier campo que describa a una persona.
5. **Costo cero como base.** Toda función del núcleo DEBE poder operarse en capas gratuitas o en hardware propio.
6. **La app DEBE funcionar abierta desde `file://` y desde un gateway IPFS** (rutas relativas, `HashRouter`, sin llamadas a backend propio).

## Al escribir código

- TypeScript estricto en todo el monorepo. Librería de protocolo: `nostr-tools`.
- Los esquemas JSON de `packages/schemas` se validan en el SDK (al publicar) y en el relay (al aceptar).
- Cada kind nuevo requiere: entrada en `03`, esquema JSON, test de validación y nota en `10-decisiones.md`.
- Los límites de capas gratuitas citados en la spec cambian con frecuencia: verifícalos en la documentación del proveedor antes de dimensionar.

## Al cambiar la spec

- La spec está cerrada como v1.0. Un cambio de requisito o de prioridad se registra como ADR nuevo en `10-decisiones.md`.
- Mantén los IDs de requisito existentes; los nuevos toman el siguiente número libre y reciben prioridad en `11-priorizacion.md`.
- Cambios incompatibles en un esquema suben el campo `v` del contenido y se registran en `10-decisiones.md`.
- La spec se escribe en español; identificadores, nombres de campos y código en inglés.
