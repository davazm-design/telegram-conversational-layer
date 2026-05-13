# Contrato `/prioriza` y `/siguiente` — matriz de Eisenhower para TDAH

## Principio
Convertir una lista caótica en UNA decisión: "tu siguiente acción". El bot NO muestra el tablero de 4 cuadrantes ni satura. Una pregunta por tarea, una sugerencia a la vez.

## Modelo

Cada `microtask` tiene opcionalmente una `priority`:

| Prioridad | Significado | UI |
|---|---|---|
| `now` | Urgente + Importante | "ahora" |
| `plan` | Importante, no urgente | "planear" |
| `quick` | Urgente pero <2 min | "rápido" |
| `later` | Ni urgente ni importante | "puede esperar" |
| (none) | Sin clasificar | "sin clasificar" |

Orden de selección de "siguiente acción": **now > plan > quick > later > none**.

Dentro del mismo nivel: la más antigua (FIFO por `created_at`).

## Persistencia (sin schema changes)

`adhd_items` ya tiene una columna `date TEXT` que **microtasks no usan**. La reciclo para guardar la prioridad. Cero migración.

Valores válidos en `date` para `type='microtask'`: `'now' | 'plan' | 'quick' | 'later'` o `NULL`.

## Capabilities nuevas

### `prioritize_tasks_start` → `/prioriza`

Arranca el flujo. Lista las microtasks **sin prioridad** y entra al paso 1.

Casos borde:
- Sin microtasks: "No tienes tareas pendientes. Empieza con /agenda."
- Todas ya priorizadas: "Todas tus tareas ya están clasificadas. Usa /siguiente para ver la próxima." (con opción "/prioriza todo" para forzar reclasificación).

### `prioritize_step` → handler interno chained vía pendingInput

Por cada tarea sin prioridad, pregunta:
```
Para "Enviar documento" (1/3):

A) Urgente (vence hoy/mañana)
B) Importante (te acerca a una meta)
C) Ambas
D) Puede esperar
```

Parsea respuesta (A→quick, B→plan, C→now, D→later), guarda con `setMicroTaskPriority`, avanza al siguiente.

Al terminar: invoca `next_action` para mostrar la siguiente automáticamente.

### `next_action` → `/siguiente`

Calcula la siguiente acción:
```
Tu siguiente acción:
"Enviar documento"
Por qué: urgente + importante.

¿Cuál sería un primer paso pequeño?
```

No sugiere el primer paso (no asume), pregunta. Si el usuario responde, ese paso se guarda como nueva micro-task `quick` o se pasa al flujo de procrastinación.

Casos borde:
- Sin microtasks: "No tienes tareas pendientes. Empieza con /agenda."
- Microtasks sin prioridad: "Tienes N tareas sin clasificar. Pasa por /prioriza primero, o usa /focus para verlas como lista."

### `/focus` mejorado

Si hay alguna microtask con prioridad asignada:
```
🎯 Tu foco de hoy:

⭐ Siguiente: "Enviar documento" (ahora)

Resto:
  ⬜ Comprar pan (planear)
  ⬜ Pagar tarjeta (rápido)
  ⬜ Reorganizar carpetas (puede esperar)
  ⬜ Llamar al doctor (sin clasificar)

_3 pendientes. Escribe "listo 1" para completar la siguiente._
```

Si NO hay prioridades:
- Comportamiento actual (lista simple con ⬜/✅).

## NL triggers

Activan `/prioriza`:
- "prioriza", "prioriza mi día", "ayúdame a priorizar", "qué es lo más importante"

Activan `/siguiente`:
- "siguiente", "qué tengo que hacer ahora", "cuál es mi siguiente", "qué hago primero"

## Tono

- "Puede esperar" en lugar de "elimina".
- "Rápido" en lugar de "delegar".
- "Ahora" / "planear" — neutrales.
- "Tu siguiente acción" — sin "tienes que".
- Cierre siempre con pregunta abierta o acción pequeña.

## Crisis

El crisis pre-filter sigue ganando antes que cualquier paso de este flujo. Si durante `/prioriza` el usuario dice "no puedo más", el sistema lo intercepta y entrega el mensaje fijo de crisis, sin guardar nada de la priorización.

## Tests obligatorios

1. `/prioriza` sin microtasks → mensaje claro.
2. `/prioriza` con 3 microtasks, responder A/B/C/D guarda cada `priority` correcto.
3. `/prioriza` re-entrada (todas ya priorizadas) → mensaje informativo.
4. `/siguiente` con prioridades mixtas → muestra la `now` más antigua.
5. `/siguiente` sin prioridades pero con tareas → invita a `/prioriza`.
6. `/siguiente` sin nada → invita a `/agenda`.
7. `/focus` con prioridades → marca la "siguiente" arriba.
8. `/focus` sin prioridades → lista plana como antes.
9. NL "prioriza mi día" → `/prioriza`.
10. NL "qué tengo que hacer ahora" / "cuál es mi siguiente" → `/siguiente`.
11. `/borrar N` y `/editar N` siguen funcionando con priorities asignadas.
12. `setMicroTaskPriority` persiste correctamente en memory y postgres.
13. Crisis durante `/prioriza` gana.

## No tocar
- crisis pre-filter, Telegram adapter, webhook, tick, storage de recordatorios,
- /recordatorios, /silencio, /privacidad, /recursos.
