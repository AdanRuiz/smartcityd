# Bitácora del agente

Issue fijado que mantiene `scripts/agent/run.ps1`: cada corrida que hace algo o falla deja aquí un comentario. Las corridas sin nada que hacer no comentan. Para recibir los avisos, suscríbete a este issue.

| Columna | Significado |
|---|---|
| Tarea | Issue (`#n`) o `roadmap` |
| Resultado | PR abierto, PR en borrador (verificaciones rojas) o Bloqueado con el motivo |
| Turnos, Min | Tamaño de la sesión de Claude: un indicador del consumo de cuota |
| Denegaciones | Comandos que los permisos del agente rechazaron. Un aumento brusco merece revisar el log |
| USD eq. API | Lo que costaría la sesión con la API. **No se cobra**: se usa la suscripción. Sirve para comparar tareas |

No cierres este issue: si se cierra, el agente abre uno nuevo. Guía: `docs/operacion/agente.md`.
