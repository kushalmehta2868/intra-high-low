import { EventEmitter } from 'events';
import { logger } from './logger';

export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Circuit is open, rejecting requests
  HALF_OPEN = 'HALF_OPEN' // Testing if service recovered
}

export interface CircuitBreakerOptions {
  failureThreshold: number;      // Number of failures to open circuit
  successThreshold: number;      // Number of successes to close circuit (in half-open)
  timeout: number;               // Time in ms before trying half-open
  monitoringPeriod: number;      // Rolling window for failure counting (ms)
  volumeThreshold: number;       // Minimum requests before considering failure rate
  errorFilter?: (error: any) => boolean; // Filter which errors should count
}

interface RequestRecord {
  timestamp: number;
  success: boolean;
  error?: any;
}

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private nextAttemptTime: number = 0;
  private requestHistory: RequestRecord[] = [];
  private options: CircuitBreakerOptions;
  private name: string;

  private static defaultOptions: CircuitBreakerOptions = {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 60000, // 1 minute
    monitoringPeriod: 60000, // 1 minute rolling window
    volumeThreshold: 10,
    errorFilter: (error: any) => true // Count all errors by default
  };

  constructor(name: string, options?: Partial<CircuitBreakerOptions>) {
    super();
    this.name = name;
    this.options = { ...CircuitBreaker.defaultOptions, ...options };

    logger.info('Circuit breaker initialized', {
      name: this.name,
      options: this.options
    });
  }

  /**
   * Execute a function through the circuit breaker
   */
  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttemptTime) {
        const error = new Error(`Circuit breaker '${this.name}' is OPEN`);
        logger.warn('Circuit breaker rejecting request', {
          name: this.name,
          state: this.state,
          nextAttemptIn: this.nextAttemptTime - Date.now()
        });
        throw error;
      } else {
        // Try half-open state
        this.transitionTo(CircuitState.HALF_OPEN);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error: any) {
      this.onFailure(error);
      throw error;
    }
  }

  /**
   * Handle successful request
   */
  private onSuccess(): void {
    this.recordRequest(true);

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;

      logger.info('Circuit breaker success in half-open', {
        name: this.name,
        successCount: this.successCount,
        threshold: this.options.successThreshold
      });

      if (this.successCount >= this.options.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
        this.reset();
      }
    } else if (this.state === CircuitState.CLOSED) {
      this.failureCount = Math.max(0, this.failureCount - 1); // Decay failures
    }
  }

  /**
   * Handle failed request
   */
  private onFailure(error: any): void {
    // Check if this error should be counted
    if (this.options.errorFilter && !this.options.errorFilter(error)) {
      logger.debug('Circuit breaker ignoring filtered error', {
        name: this.name,
        error: error.message
      });
      return;
    }

    this.recordRequest(false, error);
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      logger.warn('Circuit breaker failed in half-open', {
        name: this.name,
        error: error.message
      });
      this.transitionTo(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED) {
      this.failureCount++;

      const recentRequests = this.getRecentRequests();
      const failureRate = this.calculateFailureRate(recentRequests);

      logger.debug('Circuit breaker failure recorded', {
        name: this.name,
        failureCount: this.failureCount,
        threshold: this.options.failureThreshold,
        failureRate: failureRate.toFixed(2),
        recentRequestCount: recentRequests.length
      });

      // Open circuit if threshold reached and enough volume
      if (
        this.failureCount >= this.options.failureThreshold &&
        recentRequests.length >= this.options.volumeThreshold &&
        failureRate >= 0.5 // At least 50% failure rate
      ) {
        logger.error('Circuit breaker opening due to failures', {
          name: this.name,
          failureCount: this.failureCount,
          failureRate: failureRate.toFixed(2),
          recentRequestCount: recentRequests.length
        });

        this.transitionTo(CircuitState.OPEN);
      }
    }
  }

  /**
   * Record request in history
   */
  private recordRequest(success: boolean, error?: any): void {
    this.requestHistory.push({
      timestamp: Date.now(),
      success: success,
      error: error
    });

    // Clean old records outside monitoring period
    const cutoffTime = Date.now() - this.options.monitoringPeriod;
    this.requestHistory = this.requestHistory.filter(
      record => record.timestamp > cutoffTime
    );
  }

  /**
   * Get recent requests within monitoring period
   */
  private getRecentRequests(): RequestRecord[] {
    const cutoffTime = Date.now() - this.options.monitoringPeriod;
    return this.requestHistory.filter(record => record.timestamp > cutoffTime);
  }

  /**
   * Calculate failure rate from recent requests
   */
  private calculateFailureRate(requests: RequestRecord[]): number {
    if (requests.length === 0) return 0;

    const failures = requests.filter(r => !r.success).length;
    return failures / requests.length;
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    logger.info('Circuit breaker state transition', {
      name: this.name,
      from: oldState,
      to: newState
    });

    logger.audit('CIRCUIT_BREAKER_STATE_CHANGE', {
      name: this.name,
      from: oldState,
      to: newState,
      failureCount: this.failureCount
    });

    this.emit('state_change', {
      name: this.name,
      oldState: oldState,
      newState: newState
    });

    if (newState === CircuitState.OPEN) {
      this.nextAttemptTime = Date.now() + this.options.timeout;
      this.successCount = 0;

      this.emit('open', {
        name: this.name,
        failureCount: this.failureCount,
        nextAttemptTime: this.nextAttemptTime
      });
    } else if (newState === CircuitState.HALF_OPEN) {
      this.successCount = 0;

      this.emit('half_open', {
        name: this.name
      });
    } else if (newState === CircuitState.CLOSED) {
      this.emit('closed', {
        name: this.name
      });
    }
  }

  /**
   * Reset circuit breaker counters
   */
  private reset(): void {
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.nextAttemptTime = 0;

    logger.info('Circuit breaker reset', { name: this.name });
  }

  /**
   * Manually open the circuit
   */
  public open(): void {
    logger.warn('Circuit breaker manually opened', { name: this.name });
    this.transitionTo(CircuitState.OPEN);
  }

  /**
   * Manually close the circuit
   */
  public close(): void {
    logger.info('Circuit breaker manually closed', { name: this.name });
    this.transitionTo(CircuitState.CLOSED);
    this.reset();
  }

  /**
   * Get current state
   */
  public getState(): CircuitState {
    return this.state;
  }

  /**
   * Check if circuit is allowing requests
   */
  public isOpen(): boolean {
    return this.state === CircuitState.OPEN && Date.now() < this.nextAttemptTime;
  }

  /**
   * Get circuit breaker statistics
   */
  public getStats() {
    const recentRequests = this.getRecentRequests();
    const failureRate = this.calculateFailureRate(recentRequests);

    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.nextAttemptTime,
      recentRequestCount: recentRequests.length,
      failureRate: failureRate,
      isOpen: this.isOpen()
    };
  }
}

/**
 * Circuit breaker manager for managing multiple breakers
 */
export class CircuitBreakerManager {
  private breakers: Map<string, CircuitBreaker> = new Map();

  public getOrCreate(
    name: string,
    options?: Partial<CircuitBreakerOptions>
  ): CircuitBreaker {
    if (!this.breakers.has(name)) {
      const breaker = new CircuitBreaker(name, options);
      this.breakers.set(name, breaker);

      // Forward events
      breaker.on('state_change', (data) => {
        logger.info('Circuit breaker state changed', data);
      });

      breaker.on('open', (data) => {
        logger.error('Circuit breaker opened', data);
      });
    }

    return this.breakers.get(name)!;
  }

  public get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  public getAll(): CircuitBreaker[] {
    return Array.from(this.breakers.values());
  }

  public getAllStats() {
    return Array.from(this.breakers.values()).map(breaker => breaker.getStats());
  }
}

// Singleton instance
export const circuitBreakerManager = new CircuitBreakerManager();
