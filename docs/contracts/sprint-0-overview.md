# Sprint 0 — "Mi versión funcional"

> Objetivo: dejar Compás reliable como herramienta DIARIA antes de seguir
> apilando features. Cero deuda nueva. Cada decisión, contrato. Cada cambio,
> verificado por un test que ejerza el path real de producción.

Esto es un overview ejecutivo. El contrato detallado por área vive en su
propio doc cuando el cambio lo amerita (ver `s0.1-list-snapshot.md`).

## Regla de oro (auto-impuesta)

- NO features nuevas durante esta fase. Solo bug fixes y seguridad.
- NO añadir métodos a `IAdhdCoachStore`. Esa interfaz ya carga deuda de
  vocabulario de dominio y crecerla lo empeora.
- NO crecer el god class `adhd-coach.domain.ts`. Si una acción nueva
  necesita "un método más", primero contrato.
- TODO cambio no trivial: contrato en `docs/contracts/` antes del código.

## Tareas del sprint y su estado

### S0.1 — 🔥 Fix `/borrar` + snapshot de sesión

**Bug:** el usuario veía `/recordatorios` y escribía `/borrar 1`. El bot
borraba la primera **microtask** (otro modelo) y le confirmaba éxito con
un texto que no estaba en la lista. Dos modelos, dos verbos, cero memoria
de contexto.

**Solución (contratada en `s0.1-list-snapshot.md`):**

- Nuevo en `ISessionStore`: `setLastList / getLastList / clearLastList`
  con un `ListSnapshot` agnóstico `{ kind, shownAt, items[] }`. Cumple la
  regla — no agrega vocabulario de dominio al core.
- Microtasks tienen ahora **id estable**: memory usa contador
  monotónico nunca reusado; postgres usa el `SERIAL` que ya tenía. Las
  operaciones por índice pasaron a operaciones por id (`*ById`).
- Cada handler que muestra una lista numerada (`/focus`,
  `/recordatorios`) guarda un snapshot con `kind` y `refId`s. Cada
  handler que recibe un número (`/borrar`, `/cancelar_recordatorio`,
  `/editar`, `/completar`) lo resuelve **contra ese snapshot**.
  - Si el snapshot dice `kind = 'reminders'`, `/borrar N` ahora delega
    a `/cancelar_recordatorio` — y al revés.
- Resolución en dos pasos: PRIMERO resolvemos todas las posiciones a su
  id estable, DESPUÉS borramos. Antes, borrar mutaba la lista y corrompía
  las posiciones siguientes (bug observado en `/borrar 1, 3`).

**Tests añadidos / actualizados:** `test/adhd-coach.eisenhower.test.ts`
migrado al nuevo API, `test/adhd-coach.agenda.test.ts` (`/borrar 1, 3` y
`borra 1, 2 y 3`) ya cubre el bug de mutación. `test/postgres.storage.test.ts`
verifica id estable en el path SQL.

### S0.2 — CI con Postgres real

**Por qué:** el audit fue claro — "verificado" no significaba nada cuando
el SQL real nunca corría. Patches sobre MemoryStorage pasaban verdes y
explotaban en Railway.

**Solución:**

- `.github/workflows/ci.yml` con `services.postgres: postgres:16`,
  `npm ci → npm run build → npm test → jest postgres.storage.test.ts`.
- `test/postgres.storage.test.ts` corre el contrato del provider contra
  un Postgres real (skip claro si `DATABASE_URL` no está). Cubre schema
  idempotente, TTL de pendings, id estable de microtasks, snapshot,
  recordatorios.
- `PostgresStorageProvider` ya no fuerza SSL si la URL trae
  `sslmode=disable` o si `PG_SSL=false`. CI sin SSL, prod (Railway)
  como estaba. Primer paso para cerrar la 🟠 `rejectUnauthorized: false`
  global del audit.

### S0.3 — Logger redacta secretos

**Por qué:** un `console.error` con un objeto que arrastraba el
`TELEGRAM_BOT_TOKEN` o el `OPENAI_API_KEY` filtra credenciales a los logs
de Railway, que son visibles y persistentes.

**Solución:**

- `redactSecrets(string)` en `src/core/logger.ts`. Corre sobre el JSON
  ya serializado, en TODOS los niveles. Imposible saltarla desde un call
  site.
- Defensa en dos capas: (1) reemplazo del valor exacto de las env vars
  conocidas (`TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, `DATABASE_URL`,
  `WEBHOOK_SECRET`); (2) patrones genéricos para tokens estilo Telegram
  (`\d+:[A-Za-z0-9_-]{30,}`), keys OpenAI (`sk-[...] / sk-proj-[...]`),
  y `user:password@` dentro de connection strings.
- Tests en `test/logger.redact.test.ts` para cada categoría.

### S0.4 — Índices Postgres

**Solución (folded en `initSchema`):**

```sql
CREATE INDEX IF NOT EXISTS idx_todo_items_lookup
  ON todo_items (domain_id, user_id, type);
CREATE INDEX IF NOT EXISTS idx_adhd_items_lookup
  ON adhd_items (domain_id, user_id, type);
-- Parcial: exacto para el tick de recordatorios.
CREATE INDEX IF NOT EXISTS idx_adhd_reminders_due
  ON adhd_items (domain_id, date)
  WHERE type = 'reminder' AND completed = false;
```

Idempotente, seguro re-deploy.

### S0.5 — TTL en pendings

**Por qué:** un `pending_input` o `pending_action` que nunca expira
secuestra el siguiente mensaje del usuario. Caso real ya visto: el bot
pregunta algo, el usuario se distrae, vuelve una hora después y el bot
interpreta su próximo mensaje como respuesta al prompt viejo.

**Solución:**

- Constantes únicas en `src/core/storage/ttl.ts`:
  `PENDING_INPUT_TTL_MS = 1h`, `PENDING_ACTION_TTL_MS = 5min`.
- Memory: cada pending guarda `{ value, expiresAt }`. Lectura vencida =
  null + limpieza del entry.
- Postgres: `WHERE updated_at > NOW() - INTERVAL '...'` en `get*` +
  `DELETE` perezoso en miss. Sin schema change — `updated_at` ya existía.
- Tests: `test/session.ttl.test.ts` (memory, con `jest.useFakeTimers`)
  y `test/postgres.storage.test.ts` (forzando `updated_at` al pasado).

### S0.6 — Hygiene + dead code

- Scripts ad-hoc de debug eliminados:
  `scripts/{check-multi,check-rec,check-trailing,check-typos,repro-bug,smoke-eis,smoke-reminders,verify-menu}.ts`.
  Quedó `scripts/human-walkthrough.ts` (los 127 casos de
  walkthrough, citados como parte de la metodología en `CLAUDE.md`) con
  un npm script propio: `npm run walkthrough`.
- Dead code removido en `src/core/types.ts`:
  - `interface UserSession` — sin referencias.
  - `interface PendingAction` — solo la usaba `UserSession`.
  - `IntentSource.CLASSIFIER` — enum value sin uso real.
- Constructor de `AdhdCoachDomainHandler` aceptó `sessionStore`
  opcional para no romper tests existentes que no lo pasan.

## Lo que NO se hizo (consciente, no olvido)

Estas piezas de la auditoría requieren contrato propio y un sprint
dedicado — no caben aquí sin violar la regla de oro:

- 🔴 Storage genérico (sacar `IAdhdCoachStore` del core).
- 🔴 Split del god class `adhd-coach.domain.ts`.
- 🟠 N+1 al operar por índice (ya parcialmente mitigado en
  `completeMicroTask`: `UPDATE` directo sin round-trip extra).
- 🟠 `rejectUnauthorized: false` (primer paso dado; falta cerrar).
- 🟠 `WEBHOOK_SECRET` como `secret_token` header, rate limiting.
- 🟡 `SessionManager.setContext` solo soporta `'pending_input'`.
- ESLint + Prettier + Husky.

Estas están en CLAUDE.md como deuda conocida — visibles para no
olvidarlas.
