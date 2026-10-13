# Puntos pendientes de revisión tras el cierre de la v1.0

Anotados el 2026-10-12 al cerrar la spec y priorizar con MoSCoW. No son preguntas de diseño abiertas (esas están cerradas en `spec/10-decisiones.md`): son decisiones tomadas durante el cierre que conviene que confirme el responsable del proyecto, y comprobaciones que quedaron fuera de alcance.

Cuando un punto se confirme o se cambie, bórralo de aquí; si implica cambiar un requisito o una prioridad, regístralo como ADR en `spec/10-decisiones.md`.

## 1. Q-6 sigue necesitando la medición de la fase 1

- **Qué se cerró:** qué hacer con cada resultado de la medición de CPU de la verificación Schnorr en Workers (ADR-14). Orden: JavaScript con `@noble/curves`, luego WASM, luego Workers de pago con el despliegue de costo cero en un relay estándar en hardware propio.
- **Qué falta:** la medición en sí. No se ha medido nada; sigue siendo criterio de salida de la fase 1 (`spec/09-roadmap.md`).
- **Qué revisar:** el tercer escalón no venía en la propuesta original de Q-6; se añadió al cerrar. Confirmar que es aceptable que, en el peor caso, el relay de referencia sobre Workers deje de ser el despliegue gratuito.

## 2. Q-1 cubre solo el registro oficial de kinds

- **Qué se comprobó:** la tabla de kinds del repositorio `nostr-protocol/nips` a fecha 2026-10-12. Ninguno de `1480`–`1483`, `21480`, `31480`–`31486` está registrado ni cae en un rango reservado (ADR-12).
- **Qué no se comprobó:** el uso informal de esos números en relays públicos, que no tiene registro.
- **Qué revisar:** si se quiere más certeza antes de la fase 0, consultar esos kinds en varios relays públicos grandes. Si aparece un choque, mover el bloque es un cambio incompatible.

## 3. Q-10 no nombra a los custodios

- **Qué se cerró:** la regla (TRUST-11): al menos tres custodios de organizaciones distintas, con una llave guardada fuera de línea.
- **Qué falta:** decidir quiénes son los custodios de la ciudad piloto. Es un paso operativo de la fase 2 y bloquea la publicación del evento `city`.

## 4. Dos prioridades discutibles

`spec/00-vision-y-alcance.md` dice que los cinco casos de uso fijan los requisitos de la v1, pero en `spec/11-priorizacion.md` no todos quedaron como Must:

| Asignación | Prioridad dada | Motivo | Si se quiere subir |
|---|---|---|---|
| Transporte público en vivo (kind `live`, caso de uso 3) | Could | Depende de integrar a un operador de transporte; lo efímero no se archiva | Cambiar la fila del caso 3, la del entregable y DATA-10 en la tabla por requisito |
| Fotos en reportes (adjuntos, `/v1/blob`) | Should | Necesita almacenamiento de adjuntos, que es opcional en el relay | Cambiar la fila del caso 2, la del entregable y PRIV-4, SEC-4 en la tabla por requisito |

Cambiar cualquiera de las dos exige un ADR (PRIO-4).
