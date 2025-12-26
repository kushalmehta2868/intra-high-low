import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

interface AuthState {
  loginAttempts: number;
  loginCooldownUntil: number;
  lastSaved: number;
}

/**
 * Persistent authentication state manager
 * Saves auth state to disk to survive restarts
 */
export class AuthStateManager {
  private readonly STATE_FILE_PATH: string;
  private readonly MAX_STATE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(stateFilePath?: string) {
    this.STATE_FILE_PATH = stateFilePath || path.join(process.cwd(), '.auth-state.json');
  }

  /**
   * Save authentication state to disk
   */
  public saveState(loginAttempts: number, loginCooldownUntil: number): void {
    try {
      const state: AuthState = {
        loginAttempts,
        loginCooldownUntil,
        lastSaved: Date.now()
      };

      fs.writeFileSync(this.STATE_FILE_PATH, JSON.stringify(state, null, 2));
      logger.debug('Auth state saved to disk', { loginAttempts, loginCooldownUntil });
    } catch (error: any) {
      logger.warn('Failed to save auth state', { error: error.message });
    }
  }

  /**
   * Load authentication state from disk
   */
  public loadState(): AuthState | null {
    try {
      if (!fs.existsSync(this.STATE_FILE_PATH)) {
        logger.debug('No auth state file found - starting fresh');
        return null;
      }

      const data = fs.readFileSync(this.STATE_FILE_PATH, 'utf-8');
      const state: AuthState = JSON.parse(data);

      // Check if state is too old
      const age = Date.now() - state.lastSaved;
      if (age > this.MAX_STATE_AGE_MS) {
        logger.info('Auth state too old - discarding', {
          ageHours: Math.floor(age / 3600000)
        });
        this.clearState();
        return null;
      }

      logger.info('Auth state loaded from disk', {
        loginAttempts: state.loginAttempts,
        cooldownActive: Date.now() < state.loginCooldownUntil,
        savedAgo: `${Math.floor(age / 60000)} minutes`
      });

      return state;
    } catch (error: any) {
      logger.warn('Failed to load auth state', { error: error.message });
      return null;
    }
  }

  /**
   * Clear authentication state file
   */
  public clearState(): void {
    try {
      if (fs.existsSync(this.STATE_FILE_PATH)) {
        fs.unlinkSync(this.STATE_FILE_PATH);
        logger.debug('Auth state file cleared');
      }
    } catch (error: any) {
      logger.warn('Failed to clear auth state', { error: error.message });
    }
  }
}

// Singleton instance
export const authStateManager = new AuthStateManager();
