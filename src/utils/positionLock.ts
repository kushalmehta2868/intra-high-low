import { logger } from './logger';

/**
 * Position Lock Manager - Prevents race conditions when multiple signals try to
 * open/close positions for the same symbol simultaneously
 */
export class PositionLockManager {
  private locks: Map<string, boolean> = new Map();
  private lockTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private readonly LOCK_TIMEOUT_MS = 5000; // Auto-release lock after 5 seconds

  /**
   * Acquire a lock for a symbol
   * @returns true if lock acquired, false if already locked
   */
  public async acquireLock(symbol: string): Promise<boolean> {
    if (this.locks.get(symbol)) {
      logger.warn(`Position lock already held for ${symbol}`);
      return false;
    }

    this.locks.set(symbol, true);

    // Set auto-release timeout to prevent deadlocks
    const timeout = setTimeout(() => {
      this.releaseLock(symbol);
      logger.warn(`Position lock auto-released for ${symbol} after timeout`);
    }, this.LOCK_TIMEOUT_MS);

    this.lockTimeouts.set(symbol, timeout);

    logger.debug(`Position lock acquired for ${symbol}`);
    return true;
  }

  /**
   * Release a lock for a symbol
   */
  public releaseLock(symbol: string): void {
    this.locks.delete(symbol);

    const timeout = this.lockTimeouts.get(symbol);
    if (timeout) {
      clearTimeout(timeout);
      this.lockTimeouts.delete(symbol);
    }

    logger.debug(`Position lock released for ${symbol}`);
  }

  /**
   * Check if a symbol is locked
   */
  public isLocked(symbol: string): boolean {
    return this.locks.get(symbol) || false;
  }

  /**
   * Execute a function with lock protection
   * @param symbol Symbol to lock
   * @param fn Function to execute while holding lock
   * @returns Result of function or null if lock couldn't be acquired
   */
  public async withLock<T>(
    symbol: string,
    fn: () => Promise<T>
  ): Promise<T | null> {
    const lockAcquired = await this.acquireLock(symbol);

    if (!lockAcquired) {
      logger.warn(`Could not acquire lock for ${symbol}, operation skipped`);
      return null;
    }

    try {
      const result = await fn();
      return result;
    } catch (error: any) {
      logger.error(`Error while holding lock for ${symbol}`, error);
      throw error;
    } finally {
      this.releaseLock(symbol);
    }
  }

  /**
   * Get all currently locked symbols
   */
  public getLockedSymbols(): string[] {
    return Array.from(this.locks.keys()).filter(symbol => this.locks.get(symbol));
  }

  /**
   * Force release all locks (emergency use only)
   */
  public releaseAllLocks(): void {
    logger.warn('⚠️  Force releasing all position locks');

    for (const timeout of this.lockTimeouts.values()) {
      clearTimeout(timeout);
    }

    this.locks.clear();
    this.lockTimeouts.clear();
  }

  /**
   * Get lock statistics
   */
  public getLockStats() {
    return {
      activeLocks: this.locks.size,
      lockedSymbols: this.getLockedSymbols()
    };
  }
}

// Export singleton instance
export const positionLockManager = new PositionLockManager();
