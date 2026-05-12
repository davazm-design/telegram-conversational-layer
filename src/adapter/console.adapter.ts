/**
 * Console Adapter — allows running the full pipeline without Telegram.
 * Used by the simulator for local testing.
 */

import * as readline from 'readline';
import { IMessageAdapter, GenericMessage, GenericResponse } from '../core/types';
import { logger } from '../core/logger';

const COMPONENT = 'ConsoleAdapter';

export class ConsoleAdapter implements IMessageAdapter {
  private rl: readline.Interface | null = null;
  private messageHandler: ((msg: GenericMessage) => Promise<void>) | null = null;

  constructor(private userId: string = 'console-user') {}

  async start(handler: (msg: GenericMessage) => Promise<void>): Promise<void> {
    this.messageHandler = handler;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    logger.info(COMPONENT, `Console adapter started. Type messages as user "${this.userId}". Type "exit" to quit.`);

    this.rl.on('line', async (line) => {
      const text = line.trim();
      if (!text) return;
      if (text.toLowerCase() === 'exit') {
        await this.stop();
        process.exit(0);
      }

      const msg: GenericMessage = {
        id: Date.now().toString(),
        userId: this.userId,
        chatId: this.userId,
        text,
        timestamp: new Date().toISOString(),
      };

      try {
        await handler(msg);
      } catch (err) {
        logger.error(COMPONENT, 'Error processing message', { error: String(err) });
      }
    });
  }

  async sendResponse(response: GenericResponse): Promise<void> {
    console.log(`\n🤖 Bot: ${response.text}\n`);
  }

  async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
      logger.info(COMPONENT, 'Console adapter stopped.');
    }
  }
}
