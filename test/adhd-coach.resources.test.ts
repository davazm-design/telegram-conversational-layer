/**
 * Tests del capability /recursos (show_crisis_resources) en adhd-coach.
 *
 * Verifica:
 *   - Triggers explícitos (/recursos, /crisis_recursos, NL) muestran
 *     recursos de MX, US y ES.
 *   - El pre-filter de crisis global SIGUE GANANDO sobre cualquier rule
 *     de recursos: "no quiero seguir" → CRISIS_FIXED_MESSAGE, NO la lista.
 */

import { Orchestrator } from '../src/index';
import { CRISIS_FIXED_MESSAGE } from '../src/security/crisis.detector';
import {
  GenericMessage, GenericResponse, IMessageAdapter,
} from '../src/core/types';
import { MemoryStorageProvider } from '../src/core/storage/memory.storage';
import { AdhdCoachDomainHandler } from '../src/examples/adhd-coach.domain';
import { AppConfig } from '../src/core/config';
import { setLogLevel } from '../src/core/logger';

setLogLevel('error');

class MockAdapter implements IMessageAdapter {
  public sentResponses: GenericResponse[] = [];
  private handler: ((msg: GenericMessage) => Promise<void>) | null = null;
  async start(handler: (msg: GenericMessage) => Promise<void>): Promise<void> { this.handler = handler; }
  async sendResponse(r: GenericResponse): Promise<void> { this.sentResponses.push(r); }
  async stop(): Promise<void> { this.handler = null; }
  async receive(text: string, userId = 'res-user'): Promise<void> {
    if (!this.handler) throw new Error('no handler');
    await this.handler({
      id: String(Date.now()) + Math.random().toString(36).slice(2, 8),
      userId, chatId: userId, text, timestamp: new Date().toISOString(),
    });
  }
  reset(): void { this.sentResponses = []; }
}

const cfg: AppConfig = {
  telegram: { botToken: 't', mode: 'polling', webhookSecret: '', publicWebhookUrl: '', port: 3000 },
  llm: { enabled: false, provider: 'openai', openaiApiKey: '' },
  storage: { provider: 'memory', databaseUrl: '' },
  logLevel: 'error',
};

describe('adhd-coach — /recursos (show_crisis_resources)', () => {
  let storage: MemoryStorageProvider;
  let adapter: MockAdapter;
  let orch: Orchestrator;

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    await storage.connect('adhd-resources-test');
    adapter = new MockAdapter();
    const domain = new AdhdCoachDomainHandler(storage.adhdCoachStore);
    orch = new Orchestrator(adapter, domain, cfg, storage.sessionStore);
    await orch.start();
  });

  afterEach(async () => {
    await orch.stop();
    await storage.disconnect();
  });

  const lastReply = () => adapter.sentResponses[adapter.sentResponses.length - 1]?.text;

  // 1) /recursos muestra MX, US y ES
  test('/recursos muestra los 3 países', async () => {
    await adapter.receive('/recursos');
    const r = lastReply() ?? '';
    expect(r).toContain('Recursos de apoyo');
    expect(r).toContain('México');
    expect(r).toContain('800 911 2000');
    expect(r).toContain('Estados Unidos');
    expect(r).toContain('988');
    expect(r).toContain('España');
    expect(r).toContain('024');
    expect(r).toContain('Si estás en peligro inmediato');
  });

  // 2) /crisis_recursos muestra recursos
  test('/crisis_recursos muestra recursos', async () => {
    await adapter.receive('/crisis_recursos');
    expect(lastReply()).toContain('Recursos de apoyo');
    expect(lastReply()).toContain('México');
    expect(lastReply()).toContain('Estados Unidos');
    expect(lastReply()).toContain('España');
  });

  // 3) "recursos de crisis" (NL) muestra recursos
  test('"recursos de crisis" (NL) muestra recursos', async () => {
    await adapter.receive('recursos de crisis');
    expect(lastReply()).toContain('Recursos de apoyo');
  });

  test('"línea de crisis" (NL) muestra recursos', async () => {
    await adapter.receive('línea de crisis');
    expect(lastReply()).toContain('Recursos de apoyo');
  });

  test('"emergencias" (NL) muestra recursos', async () => {
    await adapter.receive('emergencias');
    expect(lastReply()).toContain('Recursos de apoyo');
  });

  // 4) "no quiero seguir" sigue activando crisis pre-filter, NO recursos
  test('"no quiero seguir" → crisis pre-filter (NO recursos)', async () => {
    await adapter.receive('no quiero seguir');
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
    expect(lastReply()).not.toContain('Recursos de apoyo');
  });

  test('"quiero morir" → crisis pre-filter (NO recursos)', async () => {
    await adapter.receive('quiero morir');
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
    expect(lastReply()).not.toContain('Recursos de apoyo');
  });

  test('"no veo salida" → crisis pre-filter (NO recursos)', async () => {
    await adapter.receive('no veo salida');
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);
  });

  // Bonus: crisis seguido de /recursos funciona normalmente
  test('Tras crisis, /recursos del usuario sigue funcionando', async () => {
    await adapter.receive('no quiero seguir');
    expect(lastReply()).toBe(CRISIS_FIXED_MESSAGE);

    adapter.reset();
    await adapter.receive('/recursos');
    expect(lastReply()).toContain('Recursos de apoyo');
    expect(lastReply()).toContain('México');
  });
});
