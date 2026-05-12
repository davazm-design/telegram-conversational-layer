# Universal Telegram Conversational Layer

Infraestructura reutilizable para que cualquier proyecto tenga una interfaz conversacional por Telegram. No es "un bot" — es una capa universal de interacción humano-proyecto.

## Arquitectura

```
Telegram message
→ Telegram Adapter        (encapsula Telegram API)
→ Session Manager          (usuario, estado, pending actions)
→ Intent Router            (4 niveles: comando → regla → clasificador → LLM)
→ Policy Engine            (clasificación de riesgo)
→ Domain Handler           (lógica de tu proyecto)
→ Response Formatter       (respuestas breves y útiles)
→ Telegram response
```

### Módulos

| Módulo | Archivo | Responsabilidad |
|---|---|---|
| Telegram Adapter | `src/adapter/telegram.adapter.ts` | Encapsula Telegram API via grammy (polling) |
| Console Adapter | `src/adapter/console.adapter.ts` | Simulador de consola para testing |
| Session Manager | `src/core/session.manager.ts` | Estado del usuario, pending actions |
| Intent Router | `src/router/intent.router.ts` | Enrutamiento híbrido de 4 niveles |
| Capability Registry | `src/registry/capability.registry.ts` | Registro de acciones del dominio |
| Policy Engine | `src/security/policy.engine.ts` | Evaluación de riesgo y confirmaciones |
| LLM Fallback | `src/llm/llm.fallback.ts` | Orquestador del fallback LLM |
| OpenAI Provider | `src/llm/openai.provider.ts` | Implementación de referencia (OpenAI) |
| Response Formatter | `src/core/response.formatter.ts` | Formateo de respuestas |
| Orchestrator | `src/index.ts` | Pipeline principal |

---

## Inicio Rápido

### 1. Instalar

```bash
cd TELEGRAM
npm install
```

### 2. Configurar

```bash
cp .env.example .env
```

Edita `.env`:

```env
TELEGRAM_BOT_TOKEN=tu-token-aquí
TELEGRAM_MODE=polling
LLM_ENABLED=false
LLM_PROVIDER=openai
OPENAI_API_KEY=
LOG_LEVEL=info
```

### 3. Probar en Consola (sin Telegram)

```bash
npm run simulate                     # dominio por defecto (todo)
DOMAIN=todo npm run simulate         # todo/agenda
DOMAIN=adhd-coach npm run simulate   # adhd coach
```

Esto abre un chat interactivo en terminal con el pipeline completo.

**Ejemplo con Todo:**
```
> /start
> agregar tarea: comprar café
> tareas
> qué tengo hoy
```

**Ejemplo con ADHD Coach:**
```
> buenos días
> microtarea: revisar correo
> pomodoro: escribir reporte
> /focus
```

### 4. Conectar con Telegram Real

1. Habla con [@BotFather](https://t.me/BotFather) en Telegram.
2. Crea un bot con `/newbot`.
3. Copia el token al `.env` (`TELEGRAM_BOT_TOKEN=...`).
4. Ejecuta:

```bash
DOMAIN=todo npm run dev      # o adhd-coach, o tu dominio
```

5. Abre tu bot en Telegram y escribe `/start`.

### 5. Ejecutar Tests

```bash
npm test
```

---

## Deploy Nivel 1: una instancia por dominio en Railway

Este proyecto está diseñado para correr como "Nivel 1": una instancia por dominio. No hay gestión multi-tenant ni comandos de cambio dinámico de dominio.

### Pasos para desplegar:

1. **Crear proyecto en Railway:** Entra a [Railway.app](https://railway.app/) y crea un nuevo "Empty Project".
2. **Conectar GitHub:** Agrega un nuevo servicio conectando este repositorio de GitHub.
3. **Agregar Postgres:** En el mismo proyecto de Railway, agrega una base de datos PostgreSQL ("Add Plugin" -> "PostgreSQL").
4. **Configurar DATABASE_URL:** Ve a los *Settings* de tu servicio de aplicación, pestaña *Variables*, y agrega `DATABASE_URL` conectándola a la URL de tu nuevo Postgres (Railway suele sugerirlo como variable autocompletada con `${{Postgres.DATABASE_URL}}`).
5. **Generar dominio público:** Ve a *Settings* -> *Networking* de tu servicio y haz click en "Generate Domain". Copia esta URL (ej. `https://tu-proyecto.up.railway.app`).
6. **Configurar el resto de Variables:**
   - `TELEGRAM_BOT_TOKEN`: El token obtenido de BotFather.
   - `TELEGRAM_MODE`: `webhook`
   - `WEBHOOK_SECRET`: Un string secreto aleatorio (ej. generado con `openssl rand -hex 32`). **OBLIGATORIO** para aislar el path del webhook.
   - `PUBLIC_WEBHOOK_URL`: La URL pública que copiaste en el paso anterior.
   - `STORAGE_PROVIDER`: `postgres`
   - `DOMAIN`: `todo` (o el que quieras).
   - `LOG_LEVEL`: `info`
7. **Deploy:** Railway hará build e iniciará la app automáticamente. Al iniciar, el schema de Postgres se configurará automáticamente para aislar los datos del dominio actual.
8. **Probar /health:** Entra a `https://tu-proyecto.up.railway.app/health` en tu navegador. Debería responder `OK`. El token y el secret de webhook nunca se exponen aquí.
9. **Probar Telegram:** Ve a tu bot en Telegram y envía `/start` para confirmar la conexión.
10. **Revisar logs:** Revisa la pestaña *Deployments* -> *View Logs* para ver mensajes de inicio o depurar errores. Los secretos NO se imprimen en consola.

### Cómo duplicar el servicio para adhd-coach:

1. Crea **otro bot** en BotFather y obtén su `TELEGRAM_BOT_TOKEN`.
2. En tu mismo proyecto de Railway (o uno nuevo), agrega un **nuevo servicio** clonado desde este mismo repositorio.
3. Ponle las mismas variables de entorno, apuntando a la **misma `DATABASE_URL`**. **¡El aislamiento de datos está garantizado por la arquitectura!** Cada tabla en Postgres tiene una columna `domain_id` que segmenta completamente la información.
4. Configura `DOMAIN=adhd-coach`.
5. Cambia el `TELEGRAM_BOT_TOKEN` al nuevo bot.
6. Genera un nuevo `WEBHOOK_SECRET` exclusivo para esta instancia.
7. Genera un nuevo dominio para este segundo servicio y ponlo en `PUBLIC_WEBHOOK_URL`.
8. ¡Listo! Tienes dos bots corriendo independientemente con el mismo código base, compartiendo la misma base de datos sin colisiones.

---

## Selección de Dominio

El sistema soporta múltiples dominios. Se elige via variable de entorno `DOMAIN`:

| Valor | Dominio | Descripción |
|---|---|---|
| `todo` (default) | Todo / Agenda | Tareas, recordatorios, agenda |
| `adhd-coach` | ADHD Coach | Micro-tareas, check-in, Pomodoro |

Para agregar un dominio nuevo, regístralo en `getDomainRegistry()` en `src/index.ts`.

---

## Activar LLM Fallback

El LLM solo se usa cuando:
- El mensaje **no** es un comando explícito.
- El mensaje **no** coincide con ninguna regla algorítmica.
- `LLM_ENABLED=true` en `.env`.
- Hay un `OPENAI_API_KEY` configurado.

Para activar:

```env
LLM_ENABLED=true
OPENAI_API_KEY=sk-tu-api-key
```

Si el LLM no está configurado o falla, el sistema responde pidiendo aclaración — nunca se rompe.

### Control de Tokens

El LLM recibe solo:
- Mensaje actual del usuario.
- Lista de capabilities disponibles (nombres + descripciones).
- Contexto mínimo opcional (status summary).
- Instrucción de responder en JSON.

No se envía historial de conversación.

---

## Integrar esta capa en un nuevo proyecto

Checklist paso a paso para reutilizar esta capa en cualquier proyecto:

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar entorno

```bash
cp .env.example .env
# Editar .env con TELEGRAM_BOT_TOKEN y configuración deseada
```

### 3. Crear domain handler

Crea `src/domains/mi-dominio.ts` implementando `IDomainHandler`:

```typescript
import {
  IDomainHandler, Capability, ActionResult,
  RiskLevel, RulePattern,
} from '../core/types';

export class MiDominioHandler implements IDomainHandler {
  readonly domainName = 'Mi Dominio';

  getCapabilities(): Capability[] {
    return [
      // READ_ONLY — ejecución directa, sin confirmación
      {
        name: 'consultar_datos',
        description: 'Consulta información del sistema',
        parameters: {},
        riskLevel: RiskLevel.READ_ONLY,
        requiresConfirmation: false,
      },
      // LOW_RISK_WRITE — ejecución directa, crea datos
      {
        name: 'crear_registro',
        description: 'Crea un nuevo registro',
        parameters: {
          texto: { type: 'string', description: 'Contenido', required: true },
        },
        riskLevel: RiskLevel.LOW_RISK_WRITE,
        requiresConfirmation: false,
      },
      // HIGH_RISK_ACTION — siempre requiere confirmación
      {
        name: 'borrar_todo',
        description: 'Elimina todos los registros (irreversible)',
        parameters: {},
        riskLevel: RiskLevel.HIGH_RISK_ACTION,
        requiresConfirmation: true,
      },
    ];
  }

  // Opcional: comandos slash específicos del dominio
  getCommands(): Record<string, string> {
    return { '/datos': 'consultar_datos' };
  }

  // Opcional: reglas regex para lenguaje natural
  getRules(): RulePattern[] {
    return [
      {
        patterns: [/^(ver datos|mis datos|consultar)$/i],
        action: 'consultar_datos',
      },
    ];
  }

  async execute(action: string, params: Record<string, unknown>, userId: string): Promise<ActionResult> {
    switch (action) {
      case 'consultar_datos':
        return { success: true, message: '📊 Aquí están tus datos...' };
      case 'crear_registro':
        return { success: true, message: `✅ Registro creado: "${params.texto}"` };
      case 'borrar_todo':
        return { success: true, message: '🗑️ Todos los registros eliminados.' };
      default:
        return { success: false, message: `Acción "${action}" no implementada.` };
    }
  }

  async getStatusSummary(userId: string): Promise<string> {
    return 'Todo en orden.';
  }
}
```

### 4. Registrar dominio

En `src/index.ts`, agrega tu dominio al registry:

```typescript
export function getDomainRegistry(): Record<string, () => IDomainHandler> {
  return {
    'todo': () => { /* ... */ },
    'adhd-coach': () => { /* ... */ },
    'mi-dominio': () => {
      const { MiDominioHandler } = require('./domains/mi-dominio');
      return new MiDominioHandler();
    },
  };
}
```

### 5. Definir políticas de riesgo

Los niveles de riesgo se asignan por capability:

| Nivel | Comportamiento | Cuándo usarlo |
|---|---|---|
| `READ_ONLY` | Ejecución directa | Consultas, lecturas, estados |
| `LOW_RISK_WRITE` | Ejecución directa | Crear registros, agregar datos |
| `MEDIUM_RISK_WRITE` | Pide confirmación | Modificar configuración |
| `HIGH_RISK_ACTION` | **Siempre** confirma | Borrar, trading, pagos |

Regla: si un intent viene del LLM con confianza < 0.7, se fuerza confirmación sin importar el nivel.

### 6. Probar con simulador

```bash
DOMAIN=mi-dominio npm run simulate
```

### 7. Activar LLM (opcional)

Solo si necesitas entender mensajes ambiguos que tus reglas no cubren:

```env
LLM_ENABLED=true
OPENAI_API_KEY=sk-...
```

### 8. Conectar Telegram real

```bash
TELEGRAM_BOT_TOKEN=tu-token DOMAIN=mi-dominio npm run dev
```

---

## Flujo de Confirmación

```
Usuario: "borra todas mis tareas"
Bot: 🔔 Confirmación requerida
     *Elimina TODAS las tareas (irreversible)*
     Responde sí para confirmar o cancelar para descartar.

Usuario: "sí"
Bot: 🗑️ 5 tarea(s) eliminada(s).

(o)

Usuario: "cancelar"
Bot: ✅ Acción cancelada.
```

---

## Cambiar de Proveedor LLM

1. Implementa la interfaz `ILLMProvider`:

```typescript
import { ILLMProvider, LLMIntentResult, Capability } from '../core/types';

export class MiProvider implements ILLMProvider {
  readonly providerName = 'mi-provider';

  async classifyIntent(
    message: string,
    capabilities: Capability[],
    context?: string
  ): Promise<LLMIntentResult> {
    return { action: '...', params: {}, confidence: 0.9 };
  }
}
```

2. Instancia tu provider en `src/index.ts` en lugar de `OpenAIProvider`.

---

## Estructura del Proyecto

```
src/
├── adapter/
│   ├── telegram.adapter.ts    # Telegram API via grammy (polling)
│   └── console.adapter.ts     # Simulador de consola
├── core/
│   ├── types.ts               # Interfaces y contratos
│   ├── config.ts              # Carga de configuración
│   ├── logger.ts              # Logger estructurado
│   ├── session.manager.ts     # Sesiones de usuario
│   └── response.formatter.ts  # Formateo de respuestas
├── router/
│   └── intent.router.ts       # Enrutamiento híbrido (extensible)
├── registry/
│   └── capability.registry.ts # Registro de capabilities
├── security/
│   └── policy.engine.ts       # Motor de políticas
├── llm/
│   ├── llm.fallback.ts        # Orquestador LLM
│   └── openai.provider.ts     # Proveedor OpenAI
├── examples/
│   ├── todo.domain.ts         # Dominio: Todo / Agenda
│   └── adhd-coach.domain.ts   # Dominio: ADHD Coach
├── index.ts                   # Orchestrator + domain registry
└── simulator.ts               # Simulador de consola
test/
└── integration.test.ts        # 58 tests de integración
```

---

## Pendientes Recomendados

| Prioridad | Mejora |
|---|---|
| 🟡 Media | Rate limiting por usuario |
| 🟡 Media | Caché de intents frecuentes para reducir llamadas LLM |
| 🟡 Media | Nivel 3 del router: clasificador TF-IDF local |
| 🟢 Baja | Soporte para mensajes multimedia (fotos, documentos) |
| 🟢 Baja | Internacionalización (i18n) de respuestas |
| 🟢 Baja | Métricas/telemetría de uso del LLM |
| 🟢 Baja | TTL de pending_action (expiración automática) |

