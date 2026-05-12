# Contrato Fase 4 — Compás / ADHD Coach

## Principio rector
Compás no empuja desde culpa. Acompaña desde gracia, claridad y acción pequeña.

## Arquitectura
- **4A** Help humano + lenguaje natural básico (extiende lo ya hecho).
- **4B** Neuro-reset y procrastinación.
- **4C** TCC psicoeducativa guiada (`/rpec`, `/reencuadre`, `/dopar`, `/revision`).
- **4D** Espiritualidad cristiana opcional.
- **4E** Preparación futura para LLM (no integrar todavía).

## Persistencia (sin migraciones)

Todo va a la tabla `adhd_items` existente. Nuevos `type` literales:
- `neuro_reset` — marcador con timestamp.
- `procrastination_note` — `text=JSON({task, choice?})`.
- `tcc_rpec` / `tcc_reframe` / `tcc_dopar` / `tcc_review` — `text=JSON(answers)`.
- `spiritual_practice` — `text=JSON({kind, optional content})`.
- `pending_flow_draft` — `text=JSON({flow, step, answers, metadata})`, único por usuario (mismo patrón que `pending_reminder_draft`).

### API en `IAdhdCoachStore` — métodos nuevos
```typescript
setPendingFlowDraft(userId, draft): Promise<void>;
getPendingFlowDraft(userId): Promise<FlowDraft | null>;
clearPendingFlowDraft(userId): Promise<void>;
addJournalEntry(userId, type, summary): Promise<void>;
countJournalEntries(userId, types[]): Promise<number>;
```
`resetAllUserState` ya borra todo (Postgres `DELETE WHERE user`; Memory necesita limpiar nuevos maps).

## Flujos multi-paso

Mismo patrón que `/agenda`: `ActionResult.pendingInput` encadena pasos. Slash commands escapan limpiamente. Crisis pre-filter siempre gana antes.

### Generic step handler `flow_step`
Lee `pending_flow_draft.flow`, dispatch interno por flujo. Cada flujo declara su lista de preguntas y su finalización:

| Flujo | Pasos | Tipo journal |
|---|---|---|
| `rpec` | situación / pensamiento / emoción+intensidad / conducta / acción | `tcc_rpec` |
| `reencuadre` | pensamiento / evidencia a favor / evidencia matiz / versión útil / acción | `tcc_reframe` |
| `dopar` | definir / opciones / plan / acción 2min / revisión | `tcc_dopar` |
| `revision_tcc` | repetido / ayudó / obstáculo / ajuste / programar | `tcc_review` |
| `procrastination` | tarea evitada / elección A-D | `procrastination_note` |
| `spiritual_choice` | A/B/C/D/E | `spiritual_practice` |
| `neuro_or_faith` | A neurociencia / B fe / C ambos | (no persiste) |

## Capabilities nuevas (resumen)

### 4A — terminaciones
- (Sin capabilities nuevas — solo actualizar `/help`, `/privacidad`, `getFallbackMessage`, `explainCommands`.)

### 4B — Neuro + procrastinación
- `neuro_reset` (one-shot) — `/reset90`, `/soma`, NL: "estoy saturado", "estoy bloqueado", "tengo la cabeza llena", "no me da la vida", "estoy colapsado", "no sé por dónde empezar".
- `procrastination_decode` (starter) — `/procrastinacion`, NL: "estoy procrastinando", "no puedo dejar el celular", "estoy evitando una tarea", "sé qué hacer pero no empiezo", "estoy postergando", "estoy evadiendo".
- `micro_action_from_avoidance` (step 2 conceptual, expuesto como capability separada para test #16) — captura task, presenta A/B/C/D, persiste `procrastination_note`.

### 4C — TCC
- `rpec` (starter), `reencuadre` (starter), `dopar` (starter), `revision_tcc` (starter) — `/rpec`, `/reencuadre`, `/dopar`, `/revision`. Cada uno setea `pending_flow_draft` y pendingInput→`flow_step`.
- `reencuadre` triggers NL adicionales: "estoy pensando que", "siento que soy", "seguro va a salir mal", "no sirvo para esto", "siempre arruino todo", "si no lo hago perfecto no cuenta", "ya fallé".
- `flow_step` — handler genérico que avanza cualquier flow multi-paso.

### 4D — Espiritualidad
- `christian_prayer` (one-shot) — `/oracion`.
- `christian_devotional` (one-shot) — `/devocional`.
- `spiritual_mode` (starter) — `/espiritual`. Presenta A/B/C/D/E, espera elección.
- `neuro_or_faith_offer` (NL-triggered) — cuando user mezcla fe + bloqueo/procrastinación. Pregunta neurociencia/espiritualidad/ambos.

## Reglas de redirección

- `"estoy bloqueado"` → `neuro_reset` (antes era `agenda_start`).
- `"no sé por dónde empezar"` → `neuro_reset` (antes `agenda_start`).
- Mensajes con palabras de fe (`dios|fe|pecado|oración|culpa espiritual|obediencia|llamado|propósito`) **y** de bloqueo (`bloqueado|saturado|procrastin|evito|postergando`) → `neuro_or_faith_offer`. Regex con look-ahead positivo bidireccional.

## Crisis sigue siendo absoluto

El crisis pre-filter está sistémico (Step -1 del orchestrator). Cualquier frase de riesgo (`no quiero seguir`, `quiero morir`, `me quiero hacer daño`, `mejor desaparecer`, etc.) intercepta **antes** que cualquier capability de Fase 4. Tests obligatorios verifican esto.

## Tono — reglas de redacción

- Respuestas breves (≤ 6 líneas idealmente).
- Una pregunta a la vez.
- Terminar con acción pequeña o pregunta simple.
- Markdown-safe (sin `_` ni `*` sin escapar — patrón ya establecido en Fase 3).
- Prohibido en strings:
  - "es flojera", "te falta disciplina", "te falta fe", "Dios está decepcionado".
  - Diagnósticos: "tu TDAH", "tu trastorno", "te diagnostiqué".
  - Autoridad espiritual: "Dios me dijo", "Dios te dice".
- Permitido:
  - "Puede que tu sistema esté…" (probabilístico).
  - "Tu cerebro busca alivio rápido" (psicoeducación, no diagnóstico).
  - "Obediencia sencilla", "fidelidad en lo pequeño".

## /privacidad — secciones nuevas

Además de lo existente:
- `Cosmovisión declarada por ti: cristiana.`
- `Registros TCC guardados: N.`
- `Registros de procrastinación/neuro-reset: N.`
- `Prácticas espirituales guardadas: N.`

## Tests obligatorios — 35

Listados en el prompt original del usuario. Implementados en `test/adhd-coach.phase4.test.ts`.

## No tocar
- crisis pre-filter
- Telegram adapter / webhook
- storage de recordatorios
- tick proactivo
- parser de recordatorios
- `/recordatorios`, `/silencio`, `/privacidad` (solo extender texto), `/recursos`
