# Contrato `/agenda` (refactor Fase 3)

## Problema con la implementación anterior

`/agenda` prometía "ordenar tu día" pero solo hacía **un** paso de un flujo que debía tener cinco:

1. Saludaba y pedía volcado.
2. Clasificaba por keywords.
3. Preguntaba "¿eliges 3 importantes?" **sin escuchar la respuesta**.

Cuando el usuario respondía con su selección, esa respuesta volvía a caer en la regla `3+ items con coma → agenda_classify` y el bot **re-clasificaba la selección como si fuera un nuevo volcado**. Peor: el "Sí," del inicio quedaba como literal en "Otros", y al preguntar "¿ya los cargaste a mi agenda?" → fallback, porque no había concepto de "agenda guardada".

## Diseño nuevo: 4 pasos con estado

### Paso 1 — INICIO

**Triggers**
- `/agenda` (sin args)
- NL: "quiero ordenar mi día", "ayúdame a ordenar mi día", "estoy bloqueado", "no sé por dónde empezar"

**Acción**
- Handler `agenda_start` devuelve `ActionResult` con campo `pendingInput` que indica al orquestador setear:
  - `action: 'agenda_classify'`, `paramName: 'dump'`.
- Respuesta: "Vamos a ordenar el día. Vuélcame lo que tienes en bruto; yo lo separo en laboral, personal, mantenimiento, espiritual y otros."

**Atajos**
- `/agenda <texto>` → trata `<texto>` como volcado y va directo al paso 2.
- 3+ items separados por coma sin `/agenda` previo → entra directo al paso 2.

### Paso 2 — CLASIFICACIÓN

**Trigger**
- `agenda_classify` ejecutado con `dump` (vía `pending_input` desde el paso 1, o directamente).

**Acción**
1. Splittea el dump por `,` o ` y `.
2. Clasifica cada item por keywords (categorías existentes: laboral, personal, mantenimiento, espiritual, otros).
3. **Guarda la lista clasificada en `pending_agenda_selection`** (nuevo estado de dominio).
4. Devuelve `ActionResult` con `pendingInput` para `agenda_confirm_selection` param `selection`.

**Respuesta**
```
Lo separé así:
1. terminar proyecto LABDEN — laboral
2. limpiar el jardín — mantenimiento
3. poner cadena de puerta — otros
4. hacer mi devocional — espiritual

¿Cuáles eliges para hoy? Responde con números (ej: 1, 3, 5), con "todos",
o repitiendo los textos. Si nada de esto, escribe "ninguno".
```

### Paso 3 — SELECCIÓN

**Trigger**
- `agenda_confirm_selection` con `selection` (vía pending_input desde el paso 2).

**Parseo de `selection`** (en orden):
1. **Strip prefijo afirmativo**: `sí,`, `si,`, `ok,`, `dale,`, `claro,` al inicio se descartan.
2. **"todos" / "todo" / "todas"** → seleccionar todo.
3. **"ninguno" / "ninguna" / "nada"** → cancelar sin guardar.
4. **Números** 1-based separados por coma, espacio, o ` y `: `1,3,5` / `1 y 3` / `1 3 5`.
5. **Texto libre** por substring (sin acentos, sin distinguir mayúsculas): splittea por `,` o ` y `, cada parte busca el primer candidato que la contenga o sea contenido en ella. Ignora `mantenimiento:` u otros prefijos de categoría.

**Acción**
1. Para cada índice seleccionado, `store.addMicroTask(userId, candidate.text)`.
2. `store.clearPendingAgendaSelection(userId)`.
3. (No setea más pending_input — el flujo termina.)

**Respuesta**
- Si selección > 0: `"Cargué a tu día: X, Y, Z. Ver con /focus o pregunta 'qué tengo hoy'."`
- Si selección = 0 (ninguno): `"Listo, no guardé nada. Cuando quieras retomar, vuelve con /agenda."`
- Si no se entendió la selección: `"No entendí tu selección. Responde con números (1, 3, 5), 'todos' o repitiendo los textos."` (pending_input se preserva).

### Paso 4 — CONSULTA

**Triggers**
- `/focus` (existente, ya muestra microtasks).
- NL nuevos: "qué tengo hoy", "mi agenda", "ya los cargaste", "cómo va mi día".

**Acción**: `list_today_focus` (existente).

## Estado y cancelación

- `pending_input` (orquestador): marca el siguiente mensaje como input de una acción.
- `pending_agenda_selection` (dominio, **nuevo**): lista de candidatos clasificados, persistida en `adhd_items` con `type='agenda_selection'` y `text=JSON(items)`. Sin migración de schema.
- `/cancel` limpia `pending_input`. `pending_agenda_selection` sobrevive (huérfano, inofensivo) y se sobrescribe al próximo `/agenda`.
- Cualquier slash command escapa `pending_input` (fix existente del orquestador).
- `resetAllUserState` (`/borrar todo`) limpia también `pending_agenda_selection`.

## Por qué desaparece el loop de re-clasificación

La regla `3+ items con coma → agenda_classify` SOLO se evalúa cuando NO hay `pending_input`. Como `agenda_classify` setea inmediatamente `pending_input` para `agenda_confirm_selection`, la respuesta del usuario va directo al handler de selección y la regla de coma queda desactivada hasta que termine el flujo.

## Persistencia

Los items seleccionados se guardan como **microtasks** (mismo modelo existente). `/focus` y futuras consultas los muestran. Sin schema changes en Postgres: `pending_agenda_selection` reutiliza la tabla `adhd_items` con un nuevo `type` y JSON en `text`.

## Contrato técnico

### Storage (`IAdhdCoachStore`) — nuevos métodos

```typescript
setPendingAgendaSelection(
  userId: string,
  items: Array<{ text: string; category: string }>,
): Promise<void>;

getPendingAgendaSelection(
  userId: string,
): Promise<Array<{ text: string; category: string }> | null>;

clearPendingAgendaSelection(userId: string): Promise<void>;
```

### `ActionResult` — campo nuevo opcional

```typescript
export interface ActionResult {
  success: boolean;
  message: string;
  data?: unknown;
  pendingInput?: { action: string; paramName: string; prompt: string };
}
```

Orquestador, tras ejecutar la acción y enviar el mensaje, si `result.pendingInput` está presente: setea `pending_input` en la sesión. No agrega `\nprompt` al mensaje (el mensaje del handler ya lo incluye); `prompt` se guarda solo como referencia para futuros usos.

### Nueva capability

```typescript
{
  name: 'agenda_confirm_selection',
  description: 'Confirma cuáles tareas del volcado se guardan en la agenda',
  parameters: {
    selection: { type: 'string', description: 'Selección', required: true },
  },
  riskLevel: RiskLevel.LOW_RISK_WRITE,
  requiresConfirmation: false,
}
```

## Tests obligatorios

1. `/agenda` solo → prompt + pending_input listo para classify.
2. `/agenda <volcado>` → clasificación directa + pending_input para selection.
3. Volcado 3+ items sin `/agenda` → clasificación + pending_input para selection.
4. Respuesta con números `1, 3` → guarda esos 2 como microtasks.
5. Respuesta `"sí, hacer devocional, terminar LABDEN"` → strip `sí,` + match por substring + guarda los 2.
6. Respuesta `todos` → guarda toda la lista.
7. Respuesta `ninguno` → no guarda nada, limpia estado.
8. Respuesta basura → mensaje de re-prompt, pending_input se preserva.
9. `/recordatorios` durante selección → escape de pending_input + ejecuta el comando; pending_agenda_selection queda huérfano (inofensivo).
10. Re-entrar `/agenda` mientras hay `pending_agenda_selection` previo → sobrescribe sin error.
11. NO hay loop de reclasificación: la respuesta del usuario nunca se trata como nuevo volcado mientras hay pending_input.
12. "qué tengo hoy" / "mi agenda" → list_today_focus (muestra microtasks guardadas).
13. Crisis sigue ganando sobre cualquier paso del flujo.
14. `resetAllUserState` limpia `pending_agenda_selection`.

## Lo que NO se toca

- Crisis pre-filter.
- Telegram adapter.
- Webhook.
- Tick proactivo.
- Recordatorios (`/recordar`, `/recordatorios`, `/cancelar_recordatorio`).
- Parser de fechas.
- Schema de Postgres (solo nuevos `type` en `adhd_items`).
