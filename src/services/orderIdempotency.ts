import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface OrderAttempt {
  orderKey: string;
  symbol: string;
  action: string;
  timestamp: number;
  orderId?: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
}

/**
 * Order Idempotency Manager
 * Prevents duplicate orders from being placed due to retries or race conditions
 */
export class OrderIdempotencyManager extends EventEmitter {
  private orderAttempts: Map<string, OrderAttempt> = new Map();
  private readonly CLEANUP_INTERVAL_MS = 60000; // Cleanup every minute
  private readonly MAX_AGE_MS = 120000; // 2 minutes max age
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startCleanupTimer();
  }

  /**
   * Generate idempotency key for an order
   */
  public generateOrderKey(symbol: string, action: string, quantity: number): string {
    // Use timestamp rounded to nearest second to allow same order within 1 second window
    const timestamp = Math.floor(Date.now() / 1000);
    return `${symbol}_${action}_${quantity}_${timestamp}`;
  }

  /**
   * Check if order can be placed (not a duplicate)
   * Returns true if order can proceed, false if it's a duplicate
   */
  public canPlaceOrder(orderKey: string, symbol: string, action: string): boolean {
    const existing = this.orderAttempts.get(orderKey);

    if (!existing) {
      // New order, allow it
      this.registerOrderAttempt(orderKey, symbol, action);
      return true;
    }

    // Check if existing order is still pending
    if (existing.status === 'PENDING') {
      logger.warn('Duplicate order attempt detected - order still pending', {
        orderKey,
        symbol,
        action,
        originalTimestamp: new Date(existing.timestamp).toISOString()
      });

      this.emit('duplicate_order_prevented', {
        orderKey,
        symbol,
        action,
        reason: 'Order still pending'
      });

      return false;
    }

    // If completed or failed, check age
    const ageMs = Date.now() - existing.timestamp;

    if (ageMs < 5000) {
      // Less than 5 seconds old, likely a duplicate
      logger.warn('Duplicate order attempt detected - too soon after previous', {
        orderKey,
        symbol,
        action,
        ageMs,
        previousStatus: existing.status
      });

      this.emit('duplicate_order_prevented', {
        orderKey,
        symbol,
        action,
        reason: 'Too soon after previous order',
        ageMs
      });

      return false;
    }

    // Old enough, allow new attempt
    logger.info('Allowing order - previous attempt is old enough', {
      orderKey,
      ageMs,
      previousStatus: existing.status
    });

    this.registerOrderAttempt(orderKey, symbol, action);
    return true;
  }

  /**
   * Register an order attempt
   */
  private registerOrderAttempt(orderKey: string, symbol: string, action: string): void {
    const attempt: OrderAttempt = {
      orderKey,
      symbol,
      action,
      timestamp: Date.now(),
      status: 'PENDING'
    };

    this.orderAttempts.set(orderKey, attempt);

    logger.debug('Order attempt registered', {
      orderKey,
      symbol,
      action
    });
  }

  /**
   * Mark order as completed
   */
  public markOrderCompleted(orderKey: string, orderId: string): void {
    const attempt = this.orderAttempts.get(orderKey);

    if (attempt) {
      attempt.status = 'COMPLETED';
      attempt.orderId = orderId;

      logger.debug('Order marked as completed', {
        orderKey,
        orderId
      });
    }
  }

  /**
   * Mark order as failed
   */
  public markOrderFailed(orderKey: string, error?: string): void {
    const attempt = this.orderAttempts.get(orderKey);

    if (attempt) {
      attempt.status = 'FAILED';

      logger.debug('Order marked as failed', {
        orderKey,
        error
      });
    }
  }

  /**
   * Get order attempt status
   */
  public getOrderStatus(orderKey: string): 'PENDING' | 'COMPLETED' | 'FAILED' | 'NOT_FOUND' {
    const attempt = this.orderAttempts.get(orderKey);
    return attempt ? attempt.status : 'NOT_FOUND';
  }

  /**
   * Clean up old order attempts
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, attempt] of this.orderAttempts.entries()) {
      const age = now - attempt.timestamp;

      if (age > this.MAX_AGE_MS) {
        this.orderAttempts.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('Order idempotency cleanup completed', {
        cleanedCount: cleaned,
        remainingCount: this.orderAttempts.size
      });
    }
  }

  /**
   * Start automatic cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.CLEANUP_INTERVAL_MS);

    logger.info('Order idempotency manager started');
  }

  /**
   * Stop cleanup timer
   */
  public stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.orderAttempts.clear();
    logger.info('Order idempotency manager stopped');
  }

  /**
   * Get statistics
   */
  public getStats() {
    const pending = Array.from(this.orderAttempts.values()).filter(a => a.status === 'PENDING').length;
    const completed = Array.from(this.orderAttempts.values()).filter(a => a.status === 'COMPLETED').length;
    const failed = Array.from(this.orderAttempts.values()).filter(a => a.status === 'FAILED').length;

    return {
      total: this.orderAttempts.size,
      pending,
      completed,
      failed
    };
  }
}

// Singleton instance
export const orderIdempotencyManager = new OrderIdempotencyManager();
