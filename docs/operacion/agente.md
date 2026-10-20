# Agente de desarrollo sin supervisión

Guía operativa, no normativa. Al iniciar sesión en la laptop del mantenedor, un agente de Claude Code corrige los bugs que se le delegan y avanza el [product backlog](../backlog/producto.md), y entrega todo como PRs. Usa la suscripción de Claude Code del mantenedor, sin API ni SDK de pago.

No es un componente del sistema: si el agente se apaga, la ciudad no lo nota (invariante 1 de `AGENTS.md`). Ninguna pieza de la red depende de él.

## Qué hace en cada corrida

Corre 3 minutos después de iniciar sesión y luego cada hora mientras la sesión siga abierta. Una corrida sin nada que hacer solo consulta git y GitHub, no gasta cuota de Claude ni comenta en la bitácora.

1. Espera la red, actualiza un clon aislado en `%LOCALAPPDATA%\smartcity-agent\repo` y fija `pnpm` con corepack.
2. **Bugs:** toma hasta 3 issues abiertos con la etiqueta `agent`, del más antiguo al más nuevo, y salta los que ya tienen una rama `agent/issue-<n>`.
3. **Backlog:** si no hay un PR `agent/backlog-*` abierto, implementa un ítem del backlog (issues con la etiqueta `backlog`, ver [`backlog/producto.md`](../backlog/producto.md)):
   - Si no existe el milestone de la semana (`2026-W43`), lo crea y le propone los siguientes 8 ítems del agente para que el mantenedor los ajuste.
   - Toma el issue sin `humano` ni `agent:bloqueado` de número más bajo del milestone. Si no queda ninguno, toma el siguiente de la fase actual (prioridad y número) y después de la fase de adelanto, que lee de `producto.md` en `main`. Salta los que ya tienen una rama `agent/backlog-<n>`.
   - El PR lleva `Closes #n`. Al mezclarlo, en la siguiente corrida (a más tardar en una hora) arranca el siguiente ítem.
   - Si el ítem no se puede hacer, lo comenta y le pone `agent:bloqueado`, y la siguiente corrida toma otro. Si no cabe en una sesión, responde `PARTIR:` y el script crea los ítems más chicos y cierra el original.
4. Por cada tarea abre un PR contra `main`. Si `build`, `lint`, `typecheck` o `test` fallan, el PR se abre como borrador. Si el agente no puede resolver un issue, lo comenta y le pone `agent:bloqueado` (a un bug también le quita `agent`).
5. **Errores pasajeros** (cuota agotada, límite de tasa, API saturada, red caída, la CLI que no responde, o una llave o sesión inválida: 401): la tarea queda como *Reintento* en la bitácora, el issue no se toca, la corrida se detiene y el ítem del backlog no se marca. La siguiente corrida lo reintenta. Que una sesión exceda los 45 min no cuenta como pasajero, porque se repetiría: se marca bloqueada para que la tarea se parta.

**Nada se mezcla ni se despliega sin una persona.** El mantenedor revisa y mezcla cada PR.

## Límites de seguridad

| Riesgo | Contención |
|---|---|
| El modelo empuja código o abre PRs por su cuenta | Solo edita y hace commit. El clon tiene el push deshabilitado y `git push` y `gh` están denegados. El push y el PR los hace `run.ps1`, que se lee del checkout del mantenedor, no del clon. |
| Despliega a Cloudflare | `pnpm` y `node` con `deploy`, `wrangler` o `--remote` están denegados; `wrangler` y `npx` sueltos no están permitidos. La sesión corre con un `CLOUDFLARE_API_TOKEN` inválido. Las reglas se limitan a esos comandos para no bloquear `git add wrangler.toml` ni mensajes de commit que digan "deploy". |
| Se debilita sus propias reglas o las del CI | Un PR que toca `.github/`, `scripts/agent/`, `LICENSE`, `pnpm-lock.yaml` o archivos `.env`/`.dev.vars` no se abre. |
| Mete dependencias (cadena de suministro) | `pnpm add/up/dlx`, `npx`, `curl` y `wget` están denegados, y el lockfile está protegido. |
| Un issue intenta manipularlo (inyección de prompt) | Solo se toman issues con la etiqueta `agent`, que en GitHub solo pueden poner colaboradores con permiso de triage. El prompt trata el texto del issue como datos. |
| Cobra a la API en vez de usar la suscripción | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` y `ANTHROPIC_BASE_URL` se borran del entorno antes de lanzar `claude`. La única excepción buscada es el motor `openrouter` (ver abajo), que cobra por token a la llave de OpenRouter y nunca a la suscripción. |
| Se acaba la cuota de uso | Máximo 3 bugs y 1 ítem del backlog por corrida, un solo PR del backlog abierto a la vez y 45 minutos por tarea. Un ítem bloqueado no se reintenta hasta que una persona le quita `agent:bloqueado`. La bitácora registra turnos y minutos de cada sesión. |
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
- **Ajustes:** `run.ps1 -MaxIssues 1`, `-SkipBacklog` (antes `-SkipRoadmap`, que sigue funcionando), `-SprintSize 5`, `-TaskTimeoutMinutes 20` y `-Model <id>`. Para cambiarlos en la tarea programada, edita sus argumentos en `install.ps1`.

## Agente Gemini (en paralelo)

Un segundo agente, igual al de Claude pero con Gemini a través de la CLI de Antigravity (`agy`), trabaja al mismo tiempo en otros ítems del backlog. Usa la cuenta de Google con la que iniciaste sesión en `agy`, **nunca una API key**: `run.ps1 -Engine gemini` no arranca si el `settings.json` de `agy` tiene `"modelProvider": "gemini"` (el modo con API key) y borra `GEMINI_API_KEY` del entorno. Gemini CLI ya no sirve para esto: Google dejó de aceptar cuentas personales en él y pide pasar a Antigravity.

- **Qué toma:** solo issues `backlog` con la etiqueta `gemini`, con las mismas reglas de orden, sprint y bloqueo. El agente Claude salta esos issues, así que nunca trabajan en el mismo ítem. A Gemini le tocan áreas de código separadas (la app y el firmware); para darle otro ítem, ponle `gemini`.
- **Qué no toma:** bugs con `agent` (son del agente Claude) ni nada con `humano`.
- **Aislado del otro agente:** su propio clon y logs en `%LOCALAPPDATA%\smartcity-agent-gemini`, rama `agent/gemini-<n>` y un PR abierto a la vez, independiente del de Claude. Comparten la bitácora, las métricas (por modelo) y la pausa con `agent:pausa`.
- **Permisos:** sin supervisión, `agy` deniega toda herramienta que su configuración no permita, sin quedarse esperando. Leer y escribir dentro del clon está permitido; los comandos, no. `agy` no admite otra carpeta de configuración, así que `install.ps1 -Engine gemini` agrega a **tu** `~/.gemini/antigravity-cli/settings.json` las mismas reglas que tiene Claude (`permissions.allow`: `pnpm`, `node`, `git status`, `git commit`…; `permissions.deny`: `git push`, `gh`, `pnpm add`, `npx`, `curl`, despliegues…) y guarda una copia del archivo al lado. **Ojo:** esas reglas valen también cuando usas `agy` a mano. `run.ps1` no arranca si falta alguna o si `toolPermission` es `always-proceed`. Las protecciones del script (push deshabilitado, rutas protegidas, verificaciones) son las mismas.
- **Reglas como expresiones regulares:** en `agy` 1.1.28, `*` no es comodín y la regla se compara con la línea completa; sí funcionan `command(regex:...)` y que `deny` gane sobre `allow`. Cada comando permitido solo acepta después palabras simples o texto entre comillas, sin `;`, `&`, `|`, `$`, `` ` ``, `%`, paréntesis, llaves ni redirecciones, para que no se pueda encadenar otro comando (`pnpm test; gh pr create`). Probado: `git status`, `pnpm test` y `git commit -m "… (PB-1)"` corren; `gh`, `git push`, `git remote`, `git config`, `pnpm add`, `pnpm exec wrangler deploy`, `curl` y los encadenados se rechazan.
- **Un rechazo corta el turno:** `agy` termina con la respuesta vacía cuando rechaza un comando. El script reanuda la misma conversación (`--conversation`) con la lista de comandos permitidos, hasta 5 veces y dentro de los 45 minutos de la tarea; el prompt ya trae esa lista desde el principio.
- **Tarea por archivo:** `agy -p` no lee la entrada estándar, así que el script deja el prompt en `.agent-task.md` en la raíz del clon, excluido de git, y lo borra al terminar.
- **Modelo fijado:** `gemini-3.8-flash-high` (`agy models` lista los disponibles); para cambiarlo, `-Model` en los argumentos de la tarea.

Instalación, una sola vez, en PowerShell desde la raíz del repositorio:

```powershell
agy                          # si no hay sesión: iniciar con la cuenta de Google; salir con /quit
powershell -ExecutionPolicy Bypass -File scripts\agent\install.ps1 -Engine gemini     # reglas en settings.json de agy y tarea programada
powershell -ExecutionPolicy Bypass -File scripts\agent\run.ps1 -Engine gemini -DryRun # simulacro
```

La tarea corre 8 minutos después de iniciar sesión y luego cada hora. Si la sesión de Google vence, la bitácora muestra "agy no tiene sesion de Google": abre `agy` e inicia sesión. Para quitarlo, con sus reglas: `install.ps1 -Engine gemini -Uninstall`.

## Agente por OpenRouter (suplente de Gemini)

Un tercer motor, `run.ps1 -Engine openrouter`, corre Claude Code apuntado a [OpenRouter](https://openrouter.ai/docs/guides/guides/claude-code-integration) con un modelo barato. Sirve para seguir avanzando los ítems de Gemini cuando `agy` se queda sin cuota. **Es el único motor que cuesta dinero:** cobra por token a la llave de OpenRouter del mantenedor.

- **Mismo carril que Gemini:** toma los issues con `gemini`, usa ramas `agent/gemini-<n>` y el mismo candado (mutex) que el agente Gemini. Los dos pueden estar instalados a la vez: nunca corren al mismo tiempo, el PR abierto de uno detiene al otro y ninguno toma un ítem que ya tiene rama. Tampoco toma bugs.
- **Modelo fijado:** `deepseek/deepseek-v4.1-flash-1017` (en octubre de 2026, US$0.15 por millón de tokens de entrada y US$0.60 de salida). Para cambiarlo, `-Model <id de OpenRouter>`, nunca un alias `~…-latest`. Todos los roles de Claude Code (principal, subagentes y tareas de fondo) van a ese modelo. OpenRouter solo garantiza Claude Code con modelos de Anthropic; si DeepSeek falla con las herramientas, la alternativa barata y compatible es `anthropic/claude-haiku-5.5`.
- **Aislado de la suscripción:** usa su propia carpeta de configuración de Claude Code (`CLAUDE_CONFIG_DIR` en `%LOCALAPPDATA%\smartcity-agent-openrouter\claude-config`), así que nunca ve la sesión del mantenedor. Clon y logs, en la misma carpeta.
- **Costo:** la columna *USD eq. API* queda vacía para este motor, porque Claude Code calcula con tarifas de Anthropic. El gasto real está en el panel de OpenRouter. **Pon un límite de crédito a la llave en openrouter.ai.** Sin crédito, OpenRouter responde 402: la tarea queda como *Reintento* y el ítem no se marca.

Instalación, una sola vez, en PowerShell desde la raíz del repositorio. La llave va en una variable **de usuario**, porque es la única que ve la tarea programada; no la escribas en archivos del repo:

```powershell
[Environment]::SetEnvironmentVariable('OPENROUTER_API_KEY', '<tu llave>', 'User')   # luego abre una terminal nueva
powershell -ExecutionPolicy Bypass -File scripts\agent\run.ps1 -Engine openrouter -DryRun   # simulacro
powershell -ExecutionPolicy Bypass -File scripts\agent\install.ps1 -Engine openrouter       # tarea smartcity-agent-openrouter
```

La tarea corre 13 minutos después de iniciar sesión y luego cada hora. Para quitarla: `install.ps1 -Engine openrouter -Uninstall`. Mientras Gemini no tenga cuota, conviene deshabilitar su tarea (`Disable-ScheduledTask -TaskName smartcity-agent-gemini`) para no gastar corridas en reintentos.

## Límites conocidos

- Solo corre con la laptop encendida y la sesión iniciada. Para que corra sin la laptop, el mismo diseño se puede mover a GitHub Actions con `anthropics/claude-code-action` y un token de la suscripción (`claude setup-token`).
- Consume la misma cuota que las sesiones interactivas del mantenedor.
- El agente no puede dar los pasos humanos: designar custodios, conseguir dominios o desplegar. Esos son los issues con `humano`, que nunca toma.
