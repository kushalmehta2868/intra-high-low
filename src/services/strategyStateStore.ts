import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export interface SymbolPersistentState {
  tradesExecutedToday: number;
  isInCooldown: boolean;
  cooldownExpiresAt: number | null; // Unix timestamp (ms) when cooldown ends
  lastResetDate: string;             // YYYY-MM-DD in IST
}

interface DailyStateFile {
  [symbol: string]: SymbolPersistentState;
}

class StrategyStateStore {
  private readonly statePath = path.join(process.cwd(), 'state', 'daily_state.json');

  private getCurrentISTDate(): string {
    return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).split(',')[0].trim();
  }

  private ensureDirectory(): void {
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private readFile(): DailyStateFile {
    try {
      if (!fs.existsSync(this.statePath)) return {};
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as DailyStateFile;
    } catch {
      return {};
    }
  }

  /**
   * Load all saved states. Returns only entries whose lastResetDate matches today (IST).
   * Stale entries from prior days are silently ignored.
   */
  public loadTodayState(): DailyStateFile {
    const today = this.getCurrentISTDate();
    const all = this.readFile();
    const result: DailyStateFile = {};
    for (const [symbol, state] of Object.entries(all)) {
      if (state.lastResetDate === today) {
        result[symbol] = state;
      }
    }
    return result;
  }

  /**
   * Persist a single symbol's state.
   * Called after any trade count increment or cooldown state change.
   */
  public saveSymbolState(symbol: string, state: SymbolPersistentState): void {
    try {
      this.ensureDirectory();
      const current = this.readFile();
      current[symbol] = state;
      fs.writeFileSync(this.statePath, JSON.stringify(current, null, 2), 'utf8');
    } catch (e: any) {
      logger.warn(`[StateStore] Failed to save state for ${symbol}`, { error: e.message });
    }
  }

  /**
   * Remove today's state file (called at market open for a fresh day).
   */
  public clearDailyState(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        fs.unlinkSync(this.statePath);
        logger.info('[StateStore] Daily state file cleared for new trading day');
      }
    } catch (e: any) {
      logger.warn('[StateStore] Failed to clear daily state file', { error: e.message });
    }
  }
}

export const strategyStateStore = new StrategyStateStore();
