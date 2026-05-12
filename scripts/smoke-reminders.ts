/**
 * Smoke test: ejecuta el flujo Fase 3 (recordatorios) contra el orquestador
 * real con MemoryStorageProvider, e imprime un resumen.
 *
 * No depende del adaptador de readline ni de Telegram.
 */

import { Orchestrator } from '../src/index';
import { AdhdCoachDomainHandler } from '../src/examples/adhd-coach.domain';
import { MemoryStorageProvider } from '../src/core/storage/memory.storage';
import {
  GenericMessage,
  GenericResponse,
  IMessageAdapter,
} from '../src/core/types';
import { AppConfig } from '../src/core/config';
import { setLogLevel } from '../src/core/logger';

setLogLevel('error');

class CaptureAdapter implements IMessageAdapter {
  public sent: GenericResponse[] = [];
  private handler: ((msg: GenericMessage) => Promise<void>) | null = null;
  async start(h: (msg: GenericMessage) => Promise<void>): Promise<void> { this.handler = h; }
  async sendResponse(r: GenericResponse): Promise<void> { this.sent.push(r); }
  async stop(): Promise<void> { this.handler = null; }
  async send(text: string, userId = 'smoke-user'): Promise<void> {
    if (!this.handler) throw new Error('handler not set');
    await this.handler({
      id: String(Date.now()) + Math.random().toString(36).slice(2),
      userId, chatId: userId, text,
      timestamp: new Date().toISOString(),
    });
  }
  last(): string { return this.sent[this.sent.length - 1]?.text ?? '<no reply>'; }
  reset(): void { this.sent = []; }
}

function cfg(): AppConfig {
  return {
    telegram: { botToken: 'sim', mode: 'polling', webhookSecret: '', publicWebhookUrl: '', port: 0 },
    llm: { enabled: false, provider: 'openai', openaiApiKey: '' },
    storage: { provider: 'memory', databaseUrl: '' },
    logLevel: 'error',
  };
}

async function main() {
  const storage = new MemoryStorageProvider();
  await storage.connect('smoke');
  const adapter = new CaptureAdapter();
  const domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
  const orch = new Orchestrator(adapter, domain, cfg(), storage.sessionStore);
  await orch.start();

  const lines: string[] = [];
  const log = (label: string, text: string) => {
    lines.push(`\n>>> ${label}`);
    lines.push(`<<< ${text.replace(/\n/g, ' | ')}`);
  };

  // 1) /start
  await adapter.send('/start');
  log('USER: /start', adapter.last());

  // 2) Crear recordatorio relativo
  adapter.reset();
  await adapter.send('/recordar en 1h tomar agua');
  log('USER: /recordar en 1h tomar agua', adapter.last());

  // 3) Listar
  adapter.reset();
  await adapter.send('/recordatorios');
  log('USER: /recordatorios', adapter.last());

  // 4) Mañana sin hora → debe pedir hora
  adapter.reset();
  await adapter.send('/recordar mañana llamar al doctor');
  log('USER: /recordar mañana llamar al doctor', adapter.last());

  // 5) Responder con hora → completa
  adapter.reset();
  await adapter.send('9am');
  log('USER: 9am', adapter.last());

  // 6) Listar de nuevo
  adapter.reset();
  await adapter.send('/recordatorios');
  log('USER: /recordatorios', adapter.last());

  // 7) Cancelar 1
  adapter.reset();
  await adapter.send('/cancelar_recordatorio 1');
  log('USER: /cancelar_recordatorio 1', adapter.last());

  // 8) Privacidad muestra recordatorios pendientes
  adapter.reset();
  await adapter.send('/privacidad');
  log('USER: /privacidad', adapter.last());

  // 9) Tick proactivo con un vencido
  adapter.reset();
  const past = new Date(Date.now() - 5000).toISOString();
  await storage.adhdCoachStore.addReminder('smoke-user', 'Vencido', past);
  await domain.tick(async (uid, text) => orch.sendProactive(uid, text));
  log('TICK (1 vencido)', adapter.last());

  // 10) Tick con 2 vencidos → resumen
  adapter.reset();
  await storage.adhdCoachStore.addReminder('smoke-user', 'A', new Date(Date.now() - 10000).toISOString());
  await storage.adhdCoachStore.addReminder('smoke-user', 'B', new Date(Date.now() - 9000).toISOString());
  await domain.tick(async (uid, text) => orch.sendProactive(uid, text));
  log('TICK (2 vencidos)', adapter.last());

  // 11) "verlos" → muestra resumen
  adapter.reset();
  await adapter.send('verlos');
  log('USER: verlos', adapter.last());

  // ── Fechas naturales nuevas ─────────────────────────────────────────────
  adapter.reset();
  await adapter.send('/recordar pasado mañana 10:30am ir al pediatra');
  log('USER: /recordar pasado mañana 10:30am ir al pediatra', adapter.last());

  adapter.reset();
  await adapter.send('/recordar el jueves 14 de mayo a las 10:30am ir con doctor');
  log('USER: /recordar el jueves 14 de mayo a las 10:30am ir con doctor', adapter.last());

  adapter.reset();
  await adapter.send('/recordar 14/05 ir al pediatra');
  log('USER: /recordar 14/05 ir al pediatra', adapter.last());
  adapter.reset();
  await adapter.send('9am');
  log('USER: 9am (completa draft 14/05)', adapter.last());

  adapter.reset();
  await adapter.send('/recordar jueves ir al gimnasio');
  log('USER: /recordar jueves ir al gimnasio', adapter.last());
  adapter.reset();
  await adapter.send('7am');
  log('USER: 7am (completa draft jueves)', adapter.last());

  adapter.reset();
  await adapter.send('/recordar 2026-05-14 10:30 ir al pediatra');
  log('USER: /recordar 2026-05-14 10:30 ir al pediatra', adapter.last());

  adapter.reset();
  await adapter.send('/recordatorios');
  log('USER: /recordatorios (final)', adapter.last());

  // ── Fase 4 NL conversacional ────────────────────────────────────────────
  adapter.reset();
  await adapter.send('/help');
  log('USER: /help (curado)', adapter.last());

  adapter.reset();
  await adapter.send('¿Qué puedes hacer?');
  log('USER: ¿Qué puedes hacer?', adapter.last());

  adapter.reset();
  await adapter.send('¿Para qué me sirve cada comando?');
  log('USER: ¿Para qué me sirve cada comando?', adapter.last());

  adapter.reset();
  await adapter.send('¿No dices que puedo escribir en lenguaje natural?');
  log('USER: ¿No dices que puedo escribir en lenguaje natural?', adapter.last());

  adapter.reset();
  await adapter.send('asdfqwerzxcv');
  log('USER: asdfqwerzxcv (fallback orientador)', adapter.last());

  // ── Refactor /agenda (Fase 3): flujo conversacional 4 pasos ─────────────
  adapter.reset();
  await adapter.send('/agenda');
  log('USER: /agenda (paso 1: invita)', adapter.last());

  adapter.reset();
  await adapter.send('terminar proyecto LABDEN, limpiar el jardín, hacer mi devocional, pagar tarjeta');
  log('USER: <volcado> (paso 2: clasifica + pide selección)', adapter.last());

  adapter.reset();
  await adapter.send('Sí, hacer devocional, terminar LABDEN y limpiar jardín');
  log('USER: "Sí, hacer devocional..." (paso 3: guarda como microtasks)', adapter.last());

  adapter.reset();
  await adapter.send('qué tengo hoy');
  log('USER: "qué tengo hoy" (paso 4: consulta)', adapter.last());

  adapter.reset();
  await adapter.send('ya los cargaste a mi agenda');
  log('USER: "ya los cargaste a mi agenda?" → list_today_focus', adapter.last());

  // 12) Silencio + tick con vencido → no debe enviar
  adapter.reset();
  await adapter.send('/silencio 2h');
  log('USER: /silencio 2h', adapter.last());
  adapter.reset();
  await storage.adhdCoachStore.addReminder('smoke-user', 'Durante silencio', new Date(Date.now() - 1000).toISOString());
  await domain.tick(async (uid, text) => orch.sendProactive(uid, text));
  log('TICK durante silencio', adapter.sent.length === 0 ? '(sin envío — OK)' : adapter.last());

  console.log(lines.join('\n'));
  await orch.stop();
  await storage.disconnect();
}

main().catch((err) => { console.error('Smoke failed:', err); process.exit(1); });
