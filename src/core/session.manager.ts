/**
 * Session Manager — resolves user sessions and manages pending actions.
 */

import { ResolvedIntent } from './types';
import { ISessionStore } from './storage/interfaces';
import { logger } from './logger';

const COMPONENT = 'SessionManager';

export class SessionManager {
  constructor(private store: ISessionStore) {}

  /** Store a pending action awaiting confirmation. */
  async setPendingAction(userId: string, intent: ResolvedIntent, description: string): Promise<void> {
    const action = intent.action;
    await this.store.setPendingAction(userId, action);
    logger.info(COMPONENT, 'Pending action set', { userId, action: intent.action });
  }

  /** Retrieve and clear the pending action. Returns null if none exists. */
  async consumePendingAction(userId: string): Promise<string | null> {
    const action = await this.store.getPendingAction(userId);
    if (action) {
      await this.store.clearPendingAction(userId);
      logger.info(COMPONENT, 'Pending action consumed', { userId, action });
    }
    return action;
  }

  /** Check if user has a pending action. */
  async hasPendingAction(userId: string): Promise<boolean> {
    const action = await this.store.getPendingAction(userId);
    return !!action;
  }

  /** Clear pending action without executing. */
  async clearPendingAction(userId: string): Promise<boolean> {
    const action = await this.store.getPendingAction(userId);
    if (action) {
      await this.store.clearPendingAction(userId);
      logger.info(COMPONENT, 'Pending action cleared', { userId, action });
      return true;
    }
    return false;
  }

  /** Set arbitrary context data for a user's session. */
  async setContext(userId: string, key: string, value: unknown): Promise<void> {
    if (key === 'pending_input') {
      await this.store.setPendingInput(userId, value as any);
    }
  }

  /** Get context data. */
  async getContext(userId: string, key: string): Promise<unknown> {
    if (key === 'pending_input') {
      return await this.store.getPendingInput(userId);
    }
    return null;
  }
  
  /** Clear context data. */
  async clearContext(userId: string, key: string): Promise<void> {
    if (key === 'pending_input') {
      await this.store.clearPendingInput(userId);
    }
  }
}
