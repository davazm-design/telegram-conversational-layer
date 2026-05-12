/**
 * Telegram Adapter — encapsulates all Telegram-specific logic.
 *
 * Uses grammy (modern, actively maintained, zero legacy dependencies).
 * Currently supports polling mode.
 * Architecture is ready for webhook by calling bot.api.setWebhook() + bot.start() with webhook options.
 *
 * All Telegram dependencies are isolated here.
 */

import { Bot, Context, webhookCallback } from 'grammy';
import express from 'express';
import { IMessageAdapter, GenericMessage, GenericResponse } from '../core/types';
import { logger } from '../core/logger';
import { AppConfig } from '../core/config';

const COMPONENT = 'TelegramAdapter';

export class TelegramAdapter implements IMessageAdapter {
  private bot: Bot;
  private isRunning = false;
  private app: express.Express | null = null;
  private server: any = null;

  constructor(private config: AppConfig) {
    if (!config.telegram.botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN is required to start TelegramAdapter.');
    }
    this.bot = new Bot(config.telegram.botToken);
    logger.info(COMPONENT, `Adapter initialized (grammy, mode: ${config.telegram.mode}).`);
  }

  async start(handler: (msg: GenericMessage) => Promise<void>): Promise<void> {
    this.isRunning = true;

    // Handle all text messages
    this.bot.on('message:text', async (ctx: Context) => {
      try {
        const msg = ctx.message!;
        const generic: GenericMessage = {
          id: String(msg.message_id),
          userId: String(msg.from?.id ?? msg.chat.id),
          chatId: String(msg.chat.id),
          text: msg.text ?? '',
          timestamp: new Date(msg.date * 1000).toISOString(),
          metadata: {
            firstName: msg.from?.first_name,
            username: msg.from?.username,
            chatType: msg.chat.type,
          },
        };

        logger.debug(COMPONENT, 'Message received', { userId: generic.userId, text: generic.text.substring(0, 50) });
        await handler(generic);
      } catch (err) {
        logger.error(COMPONENT, 'Error processing message', { error: String(err) });
      }
    });

    // Error handler
    this.bot.catch((err) => {
      logger.error(COMPONENT, 'Bot error', { error: String(err.error) });
    });

    if (this.config.telegram.mode === 'webhook') {
      await this.startWebhook();
    } else {
      await this.startPolling();
    }
  }

  private async startPolling(): Promise<void> {
    // Start polling (non-blocking)
    this.bot.start({
      onStart: () => {
        logger.info(COMPONENT, 'Listening for messages (grammy polling)...');
      },
    });
  }

  private async startWebhook(): Promise<void> {
    if (!this.config.telegram.publicWebhookUrl) {
      throw new Error('PUBLIC_WEBHOOK_URL is required for webhook mode.');
    }
    if (!this.config.telegram.webhookSecret) {
      throw new Error('WEBHOOK_SECRET is required for webhook mode. It must not be empty.');
    }

    const port = this.config.telegram.port || parseInt(process.env.PORT || '3000', 10);
    this.app = express();

    // Health check endpoint (must be registered before any body parser or webhook)
    this.app.get('/health', (req, res) => {
      res.status(200).send('OK');
    });

    this.app.use(express.json());

    const webhookPath = `/webhook/${this.config.telegram.webhookSecret}`;
    this.app.use(webhookPath, webhookCallback(this.bot, 'express'));

    this.server = this.app.listen(port, '0.0.0.0', async () => {
      logger.info(COMPONENT, `Express server listening on port ${port} for webhooks.`);
      const webhookUrl = `${this.config.telegram.publicWebhookUrl.replace(/\/$/, '')}${webhookPath}`;
      await this.bot.api.setWebhook(webhookUrl);
      logger.info(COMPONENT, `Webhook successfully set to public URL (path hidden for security)`);
    });
  }

  async sendResponse(response: GenericResponse): Promise<void> {
    try {
      await this.bot.api.sendMessage(
        Number(response.chatId),
        response.text,
        response.parseMode ? { parse_mode: response.parseMode } : undefined,
      );
      logger.debug(COMPONENT, 'Response sent', { chatId: response.chatId });
    } catch (err) {
      logger.error(COMPONENT, 'Failed to send response', { error: String(err), chatId: response.chatId });
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    if (this.config.telegram.mode === 'webhook') {
      if (this.server) {
        this.server.close();
      }
      await this.bot.api.deleteWebhook();
      logger.info(COMPONENT, 'Webhook deleted and server stopped.');
    } else {
      await this.bot.stop();
      logger.info(COMPONENT, 'Polling stopped.');
    }

    this.isRunning = false;
    logger.info(COMPONENT, 'Adapter stopped.');
  }
}
