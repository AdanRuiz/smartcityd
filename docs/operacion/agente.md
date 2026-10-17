# Agente de desarrollo sin supervisión

Guía operativa, no normativa. Al iniciar sesión en la laptop del mantenedor, un agente de Claude Code corrige los bugs que se le delegan y avanza el roadmap, y entrega todo como PRs. Usa la suscripción de Claude Code del mantenedor, sin API ni SDK de pago.

No es un componente del sistema: si el agente se apaga, la ciudad no lo nota (invariante 1 de `AGENTS.md`). Ninguna pieza de la red depende de él.

## Qué hace en cada corrida

Corre 3 minutos después de iniciar sesión y luego cada hora mientras la sesión siga abierta. Una corrida sin nada que hacer solo consulta git y GitHub, no gasta cuota de Claude ni comenta en la bitácora.

1. Espera la red, actualiza un clon aislado en `%LOCALAPPDATA%\smartcity-agent\repo` y fija `pnpm` con corepack.
2. **Bugs:** toma hasta 3 issues abiertos con la etiqueta `agent`, del más antiguo al más nuevo, y salta los que ya tienen una rama `agent/issue-<n>`.
3. **Roadmap:** si no hay un PR `agent/roadmap-*` abierto y no lo ha intentado sobre el commit actual de `main`, implementa el siguiente entregable **Must** técnico de la primera fase sin terminar (`09`, `11`). Así, al mezclar un PR del roadmap, `main` cambia y en la siguiente corrida (a más tardar en una hora) arranca la tarea siguiente. Si un intento termina bloqueado, no se repite hasta que `main` cambie.
4. Por cada tarea abre un PR contra `main`. Si `build`, `lint`, `typecheck` o `test` fallan, el PR se abre como borrador. Si el agente no puede resolver un issue, lo comenta, le quita `agent` y le pone `agent:bloqueado`.
5. **Errores pasajeros** (cuota agotada, límite de tasa, API saturada, red caída o la CLI que no responde): la tarea queda como *Reintento* en la bitácora, el issue no se toca, la corrida se detiene y el intento diario del roadmap no se gasta. La siguiente corrida lo reintenta. Que una sesión exceda los 45 min no cuenta como pasajero, porque se repetiría: se marca bloqueada para que la tarea se parta.

**Nada se mezcla ni se despliega sin una persona.** El mantenedor revisa y mezcla cada PR.

## Límites de seguridad

| Riesgo | Contención |
|---|---|
| El modelo empuja código o abre PRs por su cuenta | Solo edita y hace commit. El clon tiene el push deshabilitado y `git push` y `gh` están denegados. El push y el PR los hace `run.ps1`, que se lee del checkout del mantenedor, no del clon. |
| Despliega a Cloudflare | `pnpm` y `node` con `deploy`, `wrangler` o `--remote` están denegados; `wrangler` y `npx` sueltos no están permitidos. La sesión corre con un `CLOUDFLARE_API_TOKEN` inválido. Las reglas se limitan a esos comandos para no bloquear `git add wrangler.toml` ni mensajes de commit que digan "deploy". |
| Se debilita sus propias reglas o las del CI | Un PR que toca `.github/`, `scripts/agent/`, `LICENSE`, `pnpm-lock.yaml` o archivos `.env`/`.dev.vars` no se abre. |
| Mete dependencias (cadena de suministro) | `pnpm add/up/dlx`, `npx`, `curl` y `wget` están denegados, y el lockfile está protegido. |
| Un issue intenta manipularlo (inyección de prompt) | Solo se toman issues con la etiqueta `agent`, que en GitHub solo pueden poner colaboradores con permiso de triage. El prompt trata el texto del issue como datos. |
| Cobra a la API en vez de usar la suscripción | `ANTHROPIC_API_KEY` y `ANTHROPIC_AUTH_TOKEN` se borran del entorno antes de lanzar `claude`. |
| Se acaba la cuota de uso | Máximo 3 issues y 1 tarea del roadmap por corrida, un solo PR del roadmap abierto a la vez, un intento del roadmap por commit de `main` y 45 minutos por tarea. La bitácora registra turnos y minutos de cada sesión. |
| Una actualización de Claude Code cambia el modelo sin avisar | El modelo está fijado (`run.ps1 -Model`, hoy `claude-opus-5-5`). El modelo realmente usado y la versión de la CLI quedan en cada PR y en cada comentario de la bitácora. |
| El agente se degrada y sigue gastando cuota | Freno automático: ver "Métricas". |

Todo lo que no está en la lista de permitidos (`$ClaudeSettings` en `run.ps1`) queda denegado, porque en modo `-p` no hay a quién preguntar.

## Instalación

Una sola vez, en PowerShell, desde la raíz del repositorio:

```powershell
winget install GitHub.cli          # gh no viene con Git
gh auth login                      # cuenta con permiso de push al repo
claude                             # comprobar que la sesión de Claude Code está iniciada; salir con /exit
powershell -ExecutionPolicy Bypass -File scripts\agent\run.ps1 -DryRun   # simulacro: elige tareas, no llama a Claude ni escribe en GitHub
powershell -ExecutionPolicy Bypass -File scripts\agent\install.ps1       # registra la tarea al iniciar sesión
```

Al registrarla, la primera corrida es 3 minutos después y de ahí cada hora, sin esperar a un nuevo inicio de sesión. Para lanzarla en el momento: `Start-ScheduledTask -TaskName smartcity-agent`. Para cambiar la frecuencia: `install.ps1 -EveryMinutes 30`. Para quitarla: `install.ps1 -Uninstall`.

## Uso diario

- **Delegar un bug:** crea el issue con pasos para reproducirlo y ponle la etiqueta `agent`. Entre más concreto, mejor PR.
- **Revisar:** los PRs llegan con un resumen, los IDs de requisito que tocan y `Closes #n`. Mezclar uno cierra su issue.
- **Desbloquear:** en un issue `agent:bloqueado`, responde lo que pidió el agente y vuelve a ponerle `agent`. Para reintentar un issue cuyo PR cerraste sin mezclar, borra también la rama `agent/issue-<n>`.
- **Pausar desde GitHub** (también desde el celular): abre un issue, por ejemplo "Pausa del agente", con la etiqueta `agent:pausa`. Mientras siga abierto, el agente no empieza ninguna tarea; si está en medio de una, la termina y no toma la siguiente. Para reanudar, cierra el issue. La etiqueta se crea en la primera corrida; si aún no existe, créala a mano con ese nombre.
- **Pausar en la laptop:** `Disable-ScheduledTask -TaskName smartcity-agent`; para reanudar, `Enable-ScheduledTask`.
- **Bitácora en GitHub:** el issue fijado con la etiqueta `agent:bitacora` recibe un comentario por cada corrida que ejecutó una tarea o falló. El comentario incluye tarea, resultado, PR, turnos, minutos y denegaciones de permisos. Las corridas sin nada que hacer no comentan. **Ojo:** el agente comenta con la cuenta de `gh`, y GitHub no notifica a nadie de su propia actividad. Si es la cuenta del mantenedor, el comentario queda en el issue pero no le llega ningún aviso. Si cierras el issue, el agente abre uno nuevo.
- **Métricas:** al final de cada corrida que ejecutó una tarea, `scripts/agent/metrics.ps1` reescribe la sección de métricas en el cuerpo del issue de bitácora. Editar el cuerpo no manda notificaciones. Los datos salen solo de GitHub, de los últimos 30 días:
  - De los PRs `agent/*`: tasa de merge, horas hasta el merge, borradores, CI rojo y tamaño.
  - De los comentarios de la bitácora: tareas, bloqueos, reintentos, turnos, minutos y denegaciones.
  - Todo se agrupa también por **versión de los prompts** (el último commit que tocó `prompt-*.md`) y por **modelo**; los dos van en el pie de cada PR y en cada comentario. Después de cambiar un prompt o el modelo, compara su tasa de merge y de bloqueos con la versión anterior.
  - **Freno automático:** si se juntan 3 tareas seguidas bloqueadas, 3 PRs seguidos cerrados sin mezclar o 3 corridas seguidas fallidas, o si una sesión tiene 15 denegaciones o más, `metrics.ps1` abre un issue "Pausa automática del agente" con la etiqueta `agent:pausa` y el motivo. Desde ese momento el agente no hace nada. Revisa la causa y **cierra el issue para reanudar**: el freno solo cuenta lo que pase después del cierre. Los reintentos por errores pasajeros no cuentan. Los umbrales son parámetros de `metrics.ps1` (`-MaxBlockedInARow`, `-MaxRejectedInARow`, `-MaxFailedRunsInARow`, `-MaxDenialsPerSession`).
  - Para consultarlas a mano: `powershell -ExecutionPolicy Bypass -File scripts\agent\metrics.ps1 -Days 7`. Agrega `-Publish` para actualizar el issue.
- **Logs locales:** `%LOCALAPPDATA%\smartcity-agent\logs` (se borran a los 30 días). `<fecha>.log` es la corrida y `<fecha>-<tarea>-claude.json`, la respuesta del modelo para cada tarea.
- **Ajustes:** `run.ps1 -MaxIssues 1`, `-SkipRoadmap`, `-TaskTimeoutMinutes 20` y `-Model <id>`. Para cambiarlos en la tarea programada, edita sus argumentos en `install.ps1`.

## Límites conocidos

- Solo corre con la laptop encendida y la sesión iniciada. Para que corra sin la laptop, el mismo diseño se puede mover a GitHub Actions con `anthropics/claude-code-action` y un token de la suscripción (`claude setup-token`).
- Consume la misma cuota que las sesiones interactivas del mantenedor.
- El agente no puede dar los pasos humanos del roadmap: designar custodios, conseguir dominios o desplegar. Esos los salta.
