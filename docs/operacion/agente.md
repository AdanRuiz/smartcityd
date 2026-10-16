# Agente de desarrollo sin supervisión

Guía operativa, no normativa. Al iniciar sesión en la laptop del mantenedor, un agente de Claude Code corrige los bugs que se le delegan y avanza el roadmap, y entrega todo como PRs. Usa la suscripción de Claude Code del mantenedor, sin API ni SDK de pago.

No es un componente del sistema: si el agente se apaga, la ciudad no lo nota (invariante 1 de `AGENTS.md`). Ninguna pieza de la red depende de él.

## Qué hace en cada arranque

1. Espera la red, actualiza un clon aislado en `%LOCALAPPDATA%\smartcity-agent\repo` y fija `pnpm` con corepack.
2. **Bugs:** toma hasta 3 issues abiertos con la etiqueta `agent`, del más antiguo al más nuevo, y salta los que ya tienen una rama `agent/issue-<n>`.
3. **Roadmap:** si no hay un PR `agent/roadmap-*` abierto y hoy no lo ha intentado, implementa el siguiente entregable **Must** técnico de la primera fase sin terminar (`09`, `11`).
4. Por cada tarea abre un PR contra `main`. Si `build`, `lint`, `typecheck` o `test` fallan, el PR se abre como borrador. Si el agente no puede resolver un issue, lo comenta, le quita `agent` y le pone `agent:bloqueado`.

**Nada se mezcla ni se despliega sin una persona.** El mantenedor revisa y mezcla cada PR.

## Límites de seguridad

| Riesgo | Contención |
|---|---|
| El modelo empuja código o abre PRs por su cuenta | Solo edita y hace commit. El clon tiene el push deshabilitado y `git push` y `gh` están denegados. El push y el PR los hace `run.ps1`, que se lee del checkout del mantenedor, no del clon. |
| Despliega a Cloudflare | `*deploy*`, `*wrangler*` y `--remote` están denegados, y la sesión corre con un `CLOUDFLARE_API_TOKEN` inválido. |
| Se debilita sus propias reglas o las del CI | Un PR que toca `.github/`, `scripts/agent/`, `LICENSE`, `pnpm-lock.yaml` o archivos `.env`/`.dev.vars` no se abre. |
| Mete dependencias (cadena de suministro) | `pnpm add/up/dlx`, `npx`, `curl` y `wget` están denegados, y el lockfile está protegido. |
| Un issue intenta manipularlo (inyección de prompt) | Solo se toman issues con la etiqueta `agent`, que en GitHub solo pueden poner colaboradores con permiso de triage. El prompt trata el texto del issue como datos. |
| Cobra a la API en vez de usar la suscripción | `ANTHROPIC_API_KEY` y `ANTHROPIC_AUTH_TOKEN` se borran del entorno antes de lanzar `claude`. |
| Se acaba la cuota de uso | Máximo 3 issues y 1 tarea del roadmap por arranque, una tarea del roadmap al día y 45 minutos por tarea. |

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

Para probarla sin reiniciar: `Start-ScheduledTask -TaskName smartcity-agent`. Para quitarla: `install.ps1 -Uninstall`.

## Uso diario

- **Delegar un bug:** crea el issue con pasos para reproducirlo y ponle la etiqueta `agent`. Entre más concreto, mejor PR.
- **Revisar:** los PRs llegan con un resumen, los IDs de requisito que tocan y `Closes #n`. Mezclar uno cierra su issue.
- **Desbloquear:** en un issue `agent:bloqueado`, responde lo que pidió el agente y vuelve a ponerle `agent`. Para reintentar un issue cuyo PR cerraste sin mezclar, borra también la rama `agent/issue-<n>`.
- **Pausar desde GitHub** (también desde el celular): abre un issue, por ejemplo "Pausa del agente", con la etiqueta `agent:pausa`. Mientras siga abierto, el agente no empieza ninguna tarea; si está en medio de una, la termina y no toma la siguiente. Para reanudar, cierra el issue. La etiqueta se crea en la primera corrida; si aún no existe, créala a mano con ese nombre.
- **Pausar en la laptop:** `Disable-ScheduledTask -TaskName smartcity-agent`; para reanudar, `Enable-ScheduledTask`.
- **Logs:** `%LOCALAPPDATA%\smartcity-agent\logs` (se borran a los 30 días). `<fecha>.log` es la corrida y `<fecha>-claude.json`, la respuesta del modelo.
- **Ajustes:** `run.ps1 -MaxIssues 1`, `-SkipRoadmap` y `-TaskTimeoutMinutes 20`. Para cambiarlos en la tarea programada, edita sus argumentos en `install.ps1`.

## Límites conocidos

- Solo corre con la laptop encendida y la sesión iniciada. Para que corra sin la laptop, el mismo diseño se puede mover a GitHub Actions con `anthropics/claude-code-action` y un token de la suscripción (`claude setup-token`).
- Consume la misma cuota que las sesiones interactivas del mantenedor.
- El agente no puede dar los pasos humanos del roadmap: designar custodios, conseguir dominios o desplegar. Esos los salta.
