import { AngelOneClient } from './client';
import { BrokerConfig } from '../../types';
import { logger } from '../../utils/logger';
import { RetryHandler } from '../../utils/retry';
import { CircuitBreaker } from '../../utils/circuitBreaker';

/**
 * Resilient wrapper around AngelOneClient with retry and circuit breaker
 */
export class ResilientAngelOneClient extends AngelOneClient {
  private circuitBreaker: CircuitBreaker;

  constructor(config: BrokerConfig) {
    super(config);

    this.circuitBreaker = new CircuitBreaker('angel_one_api', {
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 60000,
      monitoringPeriod: 120000,
      volumeThreshold: 3,
      errorFilter: (error: any) => {
        // Don't count client-side errors (4xx except 429)
        const statusCode = error.statusCode || error.response?.status;
        if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
          return false;
        }
        return true;
      }
    });

    this.setupCircuitBreakerHandlers();
  }

  private setupCircuitBreakerHandlers(): void {
    this.circuitBreaker.on('open', (data) => {
      logger.error('Angel One API circuit breaker opened', data);
    });

    this.circuitBreaker.on('half_open', () => {
      logger.info('Angel One API circuit breaker testing recovery');
    });

    this.circuitBreaker.on('closed', () => {
      logger.info('Angel One API circuit breaker closed - service recovered');
    });
  }

  /**
   * Login with retry logic
   */
  public async login(): Promise<boolean> {
    const result = await RetryHandler.executeWithRetry(
      async () => {
        return await this.circuitBreaker.execute(async () => {
          return await super.login();
        });
      },
      {
        maxAttempts: 3,
        initialDelayMs: 2000,
        maxDelayMs: 10000,
        backoffMultiplier: 2,
        shouldRetry: (error: any) => {
          // Don't retry on auth failures (wrong credentials)
          if (error.message?.includes('Invalid credentials')) {
            return false;
          }
          return true;
        }
      }
    );

    return result.success ? result.result! : false;
  }

  /**
   * Place order with retry and circuit breaker
   */
  public async placeOrder(orderRequest: any): Promise<string | null> {
    const result = await RetryHandler.executeWithRetry(
      async () => {
        return await this.circuitBreaker.execute(async () => {
          return await super.placeOrder(orderRequest);
        });
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 2,
        shouldRetry: (error: any) => {
          // Don't retry on order rejections (insufficient balance, etc.)
          if (error.message?.includes('rejected') || error.message?.includes('insufficient')) {
            return false;
          }
          return true;
        },
        onRetry: (attempt, error) => {
          logger.warn('Retrying order placement', {
            attempt: attempt,
            symbol: orderRequest.tradingsymbol,
            error: error.message
          });
        }
      }
    );

    if (!result.success) {
      logger.error('Order placement failed after retries', {
        symbol: orderRequest.tradingsymbol,
        attempts: result.attempts,
        error: result.error?.message
      });
      return null;
    }

    return result.result!;
  }

  /**
   * Cancel order with retry
   */
  public async cancelOrder(orderId: string, variety: string = 'NORMAL'): Promise<boolean> {
    const result = await RetryHandler.executeWithRetry(
      async () => {
        return await this.circuitBreaker.execute(async () => {
          return await super.cancelOrder(orderId, variety);
        });
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 2
      }
    );

    return result.success ? result.result! : false;
  }

  /**
   * Get order book with retry
   */
  public async getOrderBook(): Promise<any[]> {
    const result = await RetryHandler.executeWithRetry(
      async () => {
        return await this.circuitBreaker.execute(async () => {
          return await super.getOrderBook();
        });
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 2
      }
    );

    return result.success ? result.result! : [];
  }

  /**
   * Get positions with retry
   */
  public async getPositions(): Promise<any[]> {
    const result = await RetryHandler.executeWithRetry(
      async () => {
        return await this.circuitBreaker.execute(async () => {
          return await super.getPositions();
        });
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 2
      }
    );

    return result.success ? result.result! : [];
  }

  /**
   * Get RMS data with retry
   */
  public async getRMS(): Promise<any> {
    const result = await RetryHandler.executeWithRetry(
      async () => {
        return await this.circuitBreaker.execute(async () => {
          return await super.getRMS();
        });
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 2
      }
    );

    return result.success ? result.result! : null;
  }

  /**
   * Get LTP with retry
   */
  public async getLTP(exchange: string, tradingSymbol: string, symbolToken: string): Promise<number | null> {
    const result = await RetryHandler.executeWithRetry(
      async () => {
        return await this.circuitBreaker.execute(async () => {
          return await super.getLTP(exchange, tradingSymbol, symbolToken);
        });
      },
      {
        maxAttempts: 2,
        initialDelayMs: 500,
        maxDelayMs: 2000,
        backoffMultiplier: 2
      }
    );

    return result.success ? result.result! : null;
  }

  /**
   * Get circuit breaker stats
   */
  public getCircuitBreakerStats() {
    return this.circuitBreaker.getStats();
  }

  /**
   * Check if API is available
   */
  public isApiAvailable(): boolean {
    return !this.circuitBreaker.isOpen();
  }
}
