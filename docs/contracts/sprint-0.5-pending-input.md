# Sprint 0.5 — "pending_input ignorado" / fachadas vacías

> Esta es la clase de bug: el bot hace una pregunta en el texto pero no se
> queda a esperar la respuesta. El siguiente mensaje del usuario cae al
> router general, no encuentra reglas y aterriza en el menú genérico de
> ayuda. Desde la perspectiva del usuario, **el bot le faltó al respeto**.

## Casos detectados (audit del 18 May 2026)

Walkthrough manual con el dueño detectó tres instancias en vivo. El audit
de código completo encontró **seis** funciones con el patrón:

| # | Handler                       | Slash command(s)                 | Tipo                          |
|---|-------------------------------|----------------------------------|-------------------------------|
| 1 | `antiAbandono()`              | `/abandonar`                     | Fachada completa              |
| 2 | `restartNoGuilt()`            | `/reinicio`                      | Fachada completa              |
| 3 | `nextAction()` (cola)         | `/siguiente` y cola de `/prioriza` | Tail fachada (última pregunta) |
| 4 | `christianPrayer()`           | `/oracion`                       | Tail fachada                  |
| 5 | `christianDevotional()`       | `/devocional`                    | Tail fachada                  |
| 6 | `microActionFromAvoidance()`  | después de `/neuro_reset` y `/procrastinacion` | Tail fachada (opciones A/B/C/D huérfanas) |

"Fachada completa" = todo el handler retorna texto sin estado; el flujo
multi-paso es solo cosmético.
"Tail fachada" = el flujo SÍ funciona durante varios turnos pero la
pregunta final no setea `pendingInput`, así que la respuesta se evapora.

## Patrón canónico (referencias en el código que SÍ funcionan)

Estos handlers son el oro estándar y deben servir de plantilla:

- **`startTccFlow` + `flowStep`**: multi-step con `pendingFlowDraft` que
  preserva `step`, `answers` y `flow`. El parser de cada paso valida la
  respuesta o re-promptea (`'⚠️ Necesito que escribas una respuesta.'`)
  sin perder estado.
- **`prioritizeStep`** (Eisenhower): cuando la respuesta no es A/B/C/D,
  re-promptea con `'⚠️ Responde con A, B, C o D.'` Y devuelve el mismo
  `pendingInput` para mantener el flujo vivo.
- **`microActionFromAvoidance`** (en su PRIMERA mitad): re-prompt si el
  usuario no escribe la tarea.

## Reglas de diseño que TODO flujo multi-paso debe respetar

1. **Una pregunta por mensaje.** Si el flujo necesita diagnóstico + acción,
   son **dos turnos**, no uno. El usuario contesta lo que se le pregunta;
   no se le exige resolver dos preguntas en su cabeza.

2. **`pendingInput` o no hay pregunta.** Si el handler termina con un
   signo de interrogación, DEBE devolver `pendingInput` con la acción
   específica que procesa esa respuesta. Sin excepciones.

3. **Parser dual: respuesta natural Y letras.** Si el flujo ofrece A/B/C
   en el copy, el parser debe aceptar también las palabras que esas
   letras representan. Ejemplo: si el bot ofrece *"A) cansancio, B) miedo,
   C) frustración, D) ya no tiene sentido"*, todas estas deben funcionar:
   `A`, `a`, `cansancio`, `miedo`, `Frustración`, `frustracion`.

4. **Re-prompt preservando estado.** Si la respuesta del usuario no
   parsea, NUNCA cae al fallback genérico. El bot dice *"no te entendí
   esta parte, te repito: ¿X?"* y mantiene el mismo `pendingInput`.

5. **TTL como salvavidas, no como decisión.** El usuario abandona en
   silencio = `pending_input` expira solo (1h, ya implementado en S0.5).
   No usamos el fallback para "limpiar" estado — el TTL lo hace.

6. **Throw away semántico ≠ aceptable.** Si la respuesta del usuario
   contiene información clínica útil (palabra clave como "frustración",
   marcador de tiempo como "en 2 horas", texto que parece tarea), el flujo
   debe **ramificar** — no descartar. Ejemplo: la cola de `/prioriza` que
   pregunta "¿cuál sería un primer paso pequeño?" puede recibir
   "revisar en media hora si ya se secaron los trastes" — eso es texto +
   tiempo + acción → ofrecer crear recordatorio.

## Especificación por handler

### 1. `/abandonar` (`antiAbandono`)

Dos turnos.

Turno 1 (diagnóstico):

```
¿Esto es cansancio, miedo, frustración o ya no tiene sentido?
(puedes responder con la palabra)
```

`pendingInput.action = 'abandon_diagnose'`. Parser acepta: cansancio,
miedo, frustración (sin acento también), "ya no tiene sentido" / "no
tiene sentido" / "sin sentido". Si no parsea, re-prompt suave preservando.

Turno 2 (acción): el copy depende de la respuesta del turno 1.

- Si "cansancio" o "miedo" → ofrecer pausa breve (`A) 2 minutos, B)
  reprogramar, C) cerrar conscientemente`).
- Si "frustración" → ofrecer regulación TCC mini o pausa (`A) reframe
  rápido, B) 2 min de aire, C) cerrar`).
- Si "sin sentido" → ofrecer reflexión más larga (`A) revisar por qué
  estaba esto en mi lista, B) eliminarlo limpiamente, C) hablarlo
  conmigo`).

`pendingInput.action = 'abandon_close'`. Parser dual letras y palabras.
Re-prompt si no parsea.

### 2. `/reinicio` (`restartNoGuilt`)

Multi-paso con `pendingFlowDraft`:

- **Step 1:** "¿Cuál es tu prioridad mínima de hoy?" → guarda en draft.
- **Step 2:** "¿Qué acción de 2 minutos te acerca a esa prioridad?" →
  guarda. Si la respuesta tiene marcador de tiempo (en N min / hora),
  ofrece crear recordatorio.
- **Step 3:** Cierre — registra `restart_no_guilt` en journal, muestra
  resumen, propone `/focus` o `/prioriza`.

Cada turno setea `pendingInput.action = 'restart_step'`. Re-prompt si
respuesta vacía.

### 3. Cola de `/prioriza` (`nextAction`)

La pregunta `"¿Cuál sería un primer paso pequeño?"` debe setear
`pendingInput.action = 'capture_first_step'` con metadata del task id.

El handler `captureFirstStep`:
- Si la respuesta tiene marcador de tiempo (`en 30 min`, `mañana 9am`,
  etc.) → ofrecer crear recordatorio con ese texto y tiempo.
- Si no → registrar como nota en el journal con tipo `first_step` y
  vincular al microtask id.

### 4. `/oracion` (`christianPrayer`)

Tail con `pendingInput.action = 'capture_next_action_spiritual'`. El
handler graba la respuesta como journal `spiritual_action` y ramifica
igual que el caso 3 si trae marcador de tiempo.

### 5. `/devocional` (`christianDevotional`)

Tail con `pendingInput.action = 'capture_devotional_action'`. Mismo
patrón.

### 6. Cola de `microActionFromAvoidance` (después de /procrastinacion)

Las opciones A/B/C/D sin `pendingInput` se completan así:

- `pendingInput.action = 'avoidance_choice'`.
- Parser dual: A/B/C/D o palabras ("abrir", "imperfecta", "temporizador",
  "ayuda").
- Cada opción tiene su handler concreto:
  - A) abrir → respuesta sugerida + ofrecer microtask.
  - B) línea imperfecta → respuesta + ofrecer captura como microtask.
  - C) temporizador 2 min → ofrecer `/recordar en 2 min`.
  - D) ayuda → preguntar qué necesita aclarar y abrir flujo TCC breve.

## Criterios de aceptación

Para cada handler reescrito, los tests jest deben cubrir:

1. **Path feliz**: usuario contesta lo esperado, el flujo avanza.
2. **Respuesta natural**: el parser acepta la palabra equivalente a la
   letra.
3. **Re-prompt**: usuario contesta algo no parseable, el bot re-promptea
   con error específico Y preserva `pendingInput`.
4. **Abandono**: TTL expira → el `pendingInput` desaparece; el siguiente
   mensaje del usuario se interpreta normalmente.
5. **Crisis gana siempre**: si en medio del flujo el usuario teclea algo
   que dispara el pre-filter de crisis, ese mensaje se atiende sin que
   el flujo lo intercepte.

## Tests nuevos esperados

- `test/sprint-0.5/abandon.flow.test.ts`
- `test/sprint-0.5/restart.flow.test.ts`
- `test/sprint-0.5/prioriza-tail.flow.test.ts`
- `test/sprint-0.5/spiritual-tails.flow.test.ts`
- `test/sprint-0.5/avoidance-choice.flow.test.ts`

Cada uno con los 5 criterios arriba.

## Lo que NO entra en Sprint 0.5

- Copy de Eisenhower (rank explícito) — fix paralelo, mismo PR.
- Footer de `/focus` con `/borrar` y `/editar` — UX polish, no Sprint 0.5.
- `/agenda` confundiendo recordatorios con microtasks — patrón distinto,
  Sprint 0.6 candidato.
- Refactor de `pendingFlowDraft.metadata` para que sea estructurado
  (hoy es `Record<string, string>`) — debt 🟡, separable.

## Riesgo conocido

`pendingInput` y `pendingFlowDraft` son mecanismos paralelos en el
storage. Los flujos TCC usan `pendingFlowDraft`; los flujos simples
usan `pendingInput`. Esta dualidad es deuda existente
(`SessionManager.setContext` solo soporta `pending_input` per CLAUDE.md
deuda 🟡). Sprint 0.5 NO unifica esto — solo usa el mecanismo correcto
en cada nuevo flujo. La unificación es un sprint propio.
