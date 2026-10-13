# 08 · Seguridad y privacidad

## Supuesto base

**La infraestructura no es de confianza.** Relays, gateways, espejos y trackers pueden fallar, mentir por omisión o ser hostiles. La seguridad descansa en lo que el cliente verifica: firmas, hashes y sus propias anclas de confianza.

## Modelo de amenazas

| Amenaza | Qué puede lograr | Mitigación | Riesgo residual |
|---|---|---|---|
| Relay altera un evento | Nada: la firma deja de validar | DATA-1 | — |
| Relay oculta eventos | Vista incompleta | Leer de ≥2 relays (REPL-2); snapshots | Si todos los relays del cliente coluden |
| Relay sirve versión vieja de un direccionable | Estado desactualizado | Unir varios relays y aplicar DATA-3 | Igual que arriba |
| Datos falsos de una llave cualquiera | Ruido en el mapa | Niveles de confianza, agregados solo con `verified`, detección de atípicos | Los datos `community` siempre son falsificables |
| Sybil: miles de llaves falsas | Inundar reportes y lecturas | Límite de tasa, PoW, política `roles` en relays, filtros en cliente | Degradación de la capa `community` |
| Suplantar a la autoridad | Publicar `city`/`roles` falsos | Raíces embebidas (TRUST-1); el cliente nunca elige ancla solo (TRUST-3) | Usuario que acepta un ancla falsa manualmente |
| Robo de llave raíz | Atestiguar llaves maliciosas | Varias raíces, rotación por mayoría | Ventana hasta la rotación |
| Robo de llave de usuario/fuente | Publicar en su nombre | Llave cifrada o en extensión; revocación por `roles`/`source` | Lo publicado antes de revocar |
| Espejo de la app modificado | Robar llaves, mostrar datos falsos | Hash publicado en `release`, build reproducible, archivo único verificable, sin scripts de terceros | El usuario rara vez verifica hashes |
| XSS vía contenido de eventos | Robo de llave local | Todo `content` se trata como dato, nunca como HTML; CSP estricta; llave no exportable | — |
| Snapshot manipulado | Historial falso | Firma de cada evento + hash + varios archivistas | Omisiones de un archivista único |
| Fecha falsa (`created_at`) | Reordenar o antedatar | DATA-4; límite de antigüedad (RELAY-5); sello OTS para prueba de existencia | Antedatar hasta 30 días en relays que apliquen el límite |
| Token de dispositivo interceptado en red sin TLS | Publicar lecturas falsas vía gateway | HMAC con contador (GW-7, GW-8) | Gateway vulnerado: tiene secretos y llave |
| El navegador borra el almacenamiento local | Pérdida de llave y de cola offline | Almacenamiento persistente (SDK-11), aviso de respaldo (ID-7) | El navegador puede negar la persistencia |
| Adjunto desaparece de su alojamiento | Reporte sin imagen | Archivo opcional de adjuntos (SNAP-10 a SNAP-15) | Adjuntos que nadie archivó |
| DoS a un relay | Relay fuera de servicio | Varios relays, cola offline | — |
| Contenido ilegal en adjuntos | Responsabilidad del operador | Los blobs no viajan en eventos; cada operador puede borrarlos; moderación | El hash permanece en el evento |

## Reglas de seguridad

| ID | Regla |
|---|---|
| SEC-1 | El texto proveniente de eventos se renderiza siempre como texto. Prohibido `dangerouslySetInnerHTML` con datos de la red. Los enlaces se muestran solo con esquema `https:` o `ipfs:`. |
| SEC-2 | CSP de la app: `default-src 'self'`; `connect-src` abierto a `wss:` y `https:` (los relays son arbitrarios); sin `unsafe-eval`. |
| SEC-3 | La llave privada nunca sale del firmante: no se registra, no se envía, no se incluye en exportaciones sin cifrar. |
| SEC-4 | Las imágenes de adjuntos se cargan solo tras verificar su hash y se muestran desde un `blob:` local, nunca enlazando la URL remota directamente. |
| SEC-5 | Dependencias con versión fijada y auditoría en CI; las de criptografía se limitan a librerías auditadas (`@noble/*` vía `nostr-tools`). |
| SEC-6 | Secretos de Workers (tokens de gateway, llaves) solo como *secrets* de Wrangler; nunca en el repositorio. |

## Privacidad

El archivo es público y, en la práctica, permanente: lo que entra en un snapshot sembrado por terceros **no se puede retirar**. El borrado (kind 5) solo alcanza a relays que cooperen y a snapshots futuros. Por eso la regla es no dejar entrar datos personales.

| ID | Regla |
|---|---|
| PRIV-1 | Ningún esquema del sistema contiene campos para nombre, correo, teléfono, documento de identidad, matrícula o dirección postal de personas. |
| PRIV-2 | No se admiten datasets que registren trayectorias o presencia de personas o vehículos particulares identificables. Los conteos agregados (aforo, flujo) sí. |
| PRIV-3 | En reportes, la app redondea `loc` a 4 decimales (~11 m) por defecto y avisa que la ubicación será pública. |
| PRIV-4 | Antes de subir una foto, la app elimina metadatos EXIF, la redimensiona (lado mayor ≤ 1600 px) y recuerda no incluir rostros ni matrículas. |
| PRIV-5 | Para reportes ciudadanos la app usa por defecto una **llave desechable por reporte**, para que no se pueda perfilar a una persona uniendo sus reportes. El usuario puede optar por una identidad estable. |
| PRIV-6 | Antes de la primera publicación, la app muestra una sola vez: lo publicado es público, firmado y no se puede borrar con garantía. |
| PRIV-7 | La app no incluye analítica ni telemetría. |
| PRIV-8 | Los relays ven la IP del cliente. El relay de referencia no la almacena más allá de la ventana del límite de tasa. La app documenta que funciona tras VPN o Tor. |
| PRIV-9 | Fuentes en domicilios particulares: la app sugiere publicar la ubicación redondeada a 3 decimales (~110 m). |

### Marco legal

Las leyes de protección de datos (RGPD, LFPDPPP en México y equivalentes) otorgan derechos de supresión que un archivo distribuido no puede cumplir técnicamente. La estrategia de esta spec es de minimización: mantener los datos personales fuera del sistema. Cada operador de relay, gateway o almacenamiento de adjuntos es responsable de lo que aloja y DEBERÍA publicar un contacto para solicitudes de retiro en su documento NIP-11. Esto no sustituye asesoría legal local antes de un despliegue municipal.

## Moderación

No hay moderación global; hay capas:

1. **Operador**: decide qué acepta y qué borra en su relay.
2. **Moderadores atestiguados**: publican etiquetas (kind 1985) que los clientes aplican por defecto.
3. **Usuario**: silencia llaves y elige anclas.

Las denuncias (kind 1984) de cualquier usuario son señales para moderadores y operadores; no ocultan nada por sí solas.
