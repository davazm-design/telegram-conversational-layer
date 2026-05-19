# CLAUDE.md — Dirección del proyecto y reglas de trabajo

> Este archivo lo lee el agente al inicio de cada sesión. Es la memoria
> persistente del proyecto. Mantenerlo corto y vigente.

## North star (decisión del dueño — David, 13 May 2026)

**Hoy lo uso solo yo, pero la intención es comercializarlo.** Si me funciona
—y apuesto a que sí— lo voy a vender como producto. Por lo tanto:

- **NO se acepta deuda técnica "porque es de uso personal".** Cada decisión
  se toma como si mañana otro ingeniero leyera el código y un cliente
  dependiera de él.
- **Cimientos sólidos desde ahora.** Nada "amarrado con un hilo". Si algo
  funciona pero es frágil, no está terminado.
- **El producto puede ir adelante de la base, pero la base no se deja
  pudrir.** Antes de apilar features nuevas, la base debe estar sana.

## Reglas de trabajo (aprendidas a la mala)

1. **Contrato de diseño ANTES de código.** Para cualquier cambio no trivial:
   documento de contrato en `docs/`, revisado por el dueño (y por auditoría
   externa si aplica) antes de tocar un archivo. Ya funcionó con `/agenda` y
   Eisenhower; debe ser la norma, no la excepción.
2. **Atacar la CLASE del bug, no la instancia.** Si un bug es una de varias
   manifestaciones del mismo patrón, se arregla el patrón y se endurece el
   walkthrough con una categoría explícita.
3. **"Verificado" debe significar algo.** No declarar algo verificado si el
   path real (ej. Postgres) no se ejecutó. CI con Postgres real es requisito.
4. **Auditoría externa es parte del loop**, no un rescate de emergencia.
   Después de cada bloque grande, se audita.
5. **No mentir en el README ni en los contratos.** Si el core está acoplado
   a un dominio, el README lo dice — o se arregla el core.

## Invariantes que NO se tocan sin diseño explícito

- **Crisis pre-filter** (`src/security/crisis.detector.ts`) — gana siempre,
  antes de cualquier otra cosa.
- **Telegram adapter / webhook** — salvo el plan de migrar a `secret_token`.
- **Tick proactivo** de recordatorios.
- **Parser de fechas** de recordatorios (`parseReminderSpec` y familia).

## Deuda conocida (auditoría externa, 13 May 2026) — pendiente de hoja de ruta

- 🔴 Storage del "core" tiene vocabulario de dominio (`IAdhdCoachStore`,
  `addJournalEntry`, etc.). El README promete core agnóstico; hoy miente.
- 🔴 `src/examples/adhd-coach.domain.ts` es un god class (~3.3k LoC, ~40
  acciones en un switch).
- 🟠 Postgres sin índices secundarios; `getDueRemindersAllUsers` hace full
  scan cada 60s.
- 🟠 `ssl: { rejectUnauthorized: false }` global en el provider de Postgres.
- 🟠 N+1: cada operación por índice hace `getMicroTasks` extra.
- 🟠 `WEBHOOK_SECRET` vive como path segment, no como `secret_token` header.
- 🟠 Sin rate limiting; sin TTL en `pending_input`/`pending_action`.
- 🟡 `SessionManager` solo soporta la key `'pending_input'`; otras se
  silencian. `UserSession` en `types.ts` es dead code.
- 🟡 Tests sesgados al dominio ADHD + MemoryStorage; el SQL real nunca corre
  en CI.
- 🟡 Sin CI, sin ESLint, sin Prettier, sin Husky.

## Bug funcional conocido (detectado por el dueño, no por la auditoría)

- `/borrar N` opera sobre microtasks; `/cancelar_recordatorio N` sobre
  recordatorios. Si el usuario tiene ambos tipos y dice "borra 1" mirando
  `/recordatorios`, el bot borra la microtask equivocada y confirma éxito
  falso. **Cerrado en Sprint 0 (S0.1, commit `129962f`).**

## Sprint 0.5 — cerrado — clase de bug: "pending_input ignorado"

Detectado en producción (18 May 2026). El bot pregunta algo en su copy
y luego no consume la respuesta — el `pending_input` o no se setea, o
existe pero el parser estricto lo tira al piso, y el siguiente mensaje
del usuario cae al menú genérico de ayuda. Desde el usuario: "el bot me
faltó al respeto a la cara".

**Audit completo encontró 6 instancias:**

| Handler | Slash | Tipo |
|---|---|---|
| `antiAbandono` | `/abandonar` | Fachada completa |
| `restartNoGuilt` | `/reinicio` | Fachada completa |
| cola de `nextAction` | `/siguiente`, cola `/prioriza` | Tail fachada |
| `christianPrayer` | `/oracion` | Tail fachada |
| `christianDevotional` | `/devocional` | Tail fachada |
| cola de `microActionFromAvoidance` | post `/procrastinacion` | Tail fachada (A/B/C/D huérfanas) |

**Reglas de diseño impuestas** (ver `docs/contracts/sprint-0.5-pending-input.md`):

1. Una pregunta a la vez. Si hay diagnóstico + acción → dos turnos.
2. `pendingInput` o no preguntes. Si el handler termina con "?", DEBE
   devolver `pendingInput` con la acción que consume la respuesta.
3. Parser dual: respuesta natural (palabra) Y letra.
4. Re-prompt preservando estado si no parsea — nunca caer al fallback.
5. TTL como salvavidas (1h S0.5 input / 5min S0.5 action), no como
   herramienta de limpieza.
6. Ramificar (no descartar) info semántica útil: marcadores de tiempo en
   la respuesta → ofrecer recordatorio.

**Implementación:** los 6 handlers reescritos. `/abandonar` y `/reinicio`
ahora son flujos multi-paso reales (2 y 3 turnos). Las colas de
`/prioriza`, `/oracion`, `/devocional` y la cola post-`/procrastinacion`
setean `pendingFlowDraft` con metadata y entran al dispatcher `flowStep`
existente. Cero capabilities nuevas — patrón canónico reutilizado.

**Copy de Eisenhower** también ajustado en el mismo sprint: ahora muestra
explícitamente el rank de cada opción (`ALTA`, `MÁXIMA`, `media-baja`,
`Puede esperar`) para que la intuición del usuario coincida con la
priorización real.

**Tests:** 15 nuevos en `test/sprint-0.5.test.ts` cubriendo path feliz,
respuesta natural, re-prompt con estado preservado, y los criterios del
contrato por handler.

## Estado actual

Fase 4.3 completa (neuro-reset, procrastinación, TCC, espiritualidad,
Eisenhower). Sprint 0 completo (S0.1-S0.6: fix `/borrar`, CI Postgres,
logger redact, índices, TTL, hygiene). **Sprint 0.5 completo** (clase
"pending_input ignorado", 6 handlers reescritos + copy Eisenhower
explícito). **348 tests jest + 15 skipped Postgres. Producto desplegado
en Railway en commit `129962f` (Sprint 0); Sprint 0.5 pendiente de push.**
