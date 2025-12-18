import { EventEmitter } from 'events';
import { IBroker } from '../brokers/base';
import { PositionManager } from '../core/positionManager';
import { logger } from '../utils/logger';
import { RetryHandler } from '../utils/retry';
import { CircuitBreaker } from '../utils/circuitBreaker';

export enum RecoveryAction {
  RETRY = 'RETRY',
  RECONNECT = 'RECONNECT',
  RESYNC = 'RESYNC',
  CLOSE_POSITIONS = 'CLOSE_POSITIONS',
  ACTIVATE_KILL_SWITCH = 'ACTIVATE_KILL_SWITCH',
  ALERT_ONLY = 'ALERT_ONLY'
}

export enum ErrorSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

export interface ErrorContext {
  errorType: string;
  errorMessage: string;
  errorCode?: string;
  component: string;
  operation: string;
  timestamp: Date;
  severity: ErrorSeverity;
  recoveryAction: RecoveryAction;
  metadata?: any;
}

export interface RecoveryResult {
  success: boolean;
  action: RecoveryAction;
  message: string;
  attempts: number;
  duration: number;
}

export class ErrorRecoveryService extends EventEmitter {
  private broker: IBroker;
  private positionManager: PositionManager;
  private errorHistory: ErrorContext[] = [];
  private maxHistorySize: number = 1000;
  private recoveryInProgress: Map<string, boolean> = new Map();

  // Circuit breakers for different operations
  private orderPlacementBreaker: CircuitBreaker;
  private dataFetchBreaker: CircuitBreaker;
  private brokerConnectionBreaker: CircuitBreaker;

  constructor(broker: IBroker, positionManager: PositionManager) {
    super();
    this.broker = broker;
    this.positionManager = positionManager;

    // Initialize circuit breakers
    this.orderPlacementBreaker = new CircuitBreaker('order_placement', {
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 30000,
      volumeThreshold: 3
    });

    this.dataFetchBreaker = new CircuitBreaker('data_fetch', {
      failureThreshold: 10,
      successThreshold: 3,
      timeout: 15000,
      volumeThreshold: 5
    });

    this.brokerConnectionBreaker = new CircuitBreaker('broker_connection', {
      failureThreshold: 3,
      successThreshold: 1,
      timeout: 60000,
      volumeThreshold: 2
    });

    this.setupCircuitBreakerHandlers();
  }

  private setupCircuitBreakerHandlers(): void {
    this.orderPlacementBreaker.on('open', (data) => {
      logger.error('Order placement circuit breaker opened', data);
      this.emit('circuit_breaker_open', {
        breaker: 'order_placement',
        ...data
      });
    });

    this.brokerConnectionBreaker.on('open', async (data) => {
      logger.error('Broker connection circuit breaker opened', data);
      this.emit('circuit_breaker_open', {
        breaker: 'broker_connection',
        ...data
      });

      // Attempt broker reconnection
      await this.recoverBrokerConnection();
    });

    this.dataFetchBreaker.on('open', (data) => {
      logger.error('Data fetch circuit breaker opened', data);
      this.emit('circuit_breaker_open', {
        breaker: 'data_fetch',
        ...data
      });
    });
  }

  /**
   * Main error handler - categorizes and recovers from errors
   */
  public async handleError(error: any, context: Partial<ErrorContext>): Promise<RecoveryResult> {
    const errorContext = this.categorizeError(error, context);

    // Record error
    this.recordError(errorContext);

    logger.error('Error detected - initiating recovery', {
      component: errorContext.component,
      operation: errorContext.operation,
      severity: errorContext.severity,
      recoveryAction: errorContext.recoveryAction,
      error: errorContext.errorMessage
    });

    logger.audit('ERROR_RECOVERY_INITIATED', errorContext);

    this.emit('error_detected', errorContext);

    // Check if recovery already in progress for this component
    const recoveryKey = `${errorContext.component}:${errorContext.operation}`;
    if (this.recoveryInProgress.get(recoveryKey)) {
      logger.warn('Recovery already in progress', { recoveryKey });
      return {
        success: false,
        action: errorContext.recoveryAction,
        message: 'Recovery already in progress',
        attempts: 0,
        duration: 0
      };
    }

    this.recoveryInProgress.set(recoveryKey, true);

    try {
      const result = await this.executeRecovery(errorContext);

      logger.info('Recovery completed', {
        success: result.success,
        action: result.action,
        attempts: result.attempts,
        duration: result.duration
      });

      logger.audit('ERROR_RECOVERY_COMPLETED', {
        ...errorContext,
        result
      });

      this.emit('recovery_completed', { errorContext, result });

      return result;
    } finally {
      this.recoveryInProgress.delete(recoveryKey);
    }
  }

  /**
   * Categorize error and determine recovery action
   */
  private categorizeError(error: any, context: Partial<ErrorContext>): ErrorContext {
    const errorMessage = error.message || error.toString();
    const errorCode = error.code || error.statusCode;

    let severity = ErrorSeverity.MEDIUM;
    let recoveryAction = RecoveryAction.RETRY;

    // Network/Connection errors
    if (this.isNetworkError(error)) {
      severity = ErrorSeverity.HIGH;
      recoveryAction = RecoveryAction.RECONNECT;
    }
    // Authentication errors
    else if (this.isAuthError(error)) {
      severity = ErrorSeverity.CRITICAL;
      recoveryAction = RecoveryAction.RECONNECT;
    }
    // Rate limiting
    else if (this.isRateLimitError(error)) {
      severity = ErrorSeverity.MEDIUM;
      recoveryAction = RecoveryAction.RETRY;
    }
    // Order rejection
    else if (this.isOrderRejectionError(error)) {
      severity = ErrorSeverity.MEDIUM;
      recoveryAction = RecoveryAction.ALERT_ONLY;
    }
    // Position errors
    else if (this.isPositionError(error)) {
      severity = ErrorSeverity.HIGH;
      recoveryAction = RecoveryAction.RESYNC;
    }
    // Data sync errors
    else if (this.isDataSyncError(error)) {
      severity = ErrorSeverity.MEDIUM;
      recoveryAction = RecoveryAction.RESYNC;
    }
    // Critical system errors
    else if (this.isCriticalError(error)) {
      severity = ErrorSeverity.CRITICAL;
      recoveryAction = RecoveryAction.ACTIVATE_KILL_SWITCH;
    }

    return {
      errorType: error.constructor.name,
      errorMessage: errorMessage,
      errorCode: errorCode,
      component: context.component || 'unknown',
      operation: context.operation || 'unknown',
      timestamp: new Date(),
      severity: severity,
      recoveryAction: recoveryAction,
      metadata: context.metadata
    };
  }

  /**
   * Execute recovery action
   */
  private async executeRecovery(context: ErrorContext): Promise<RecoveryResult> {
    const startTime = Date.now();

    switch (context.recoveryAction) {
      case RecoveryAction.RETRY:
        return await this.retryOperation(context, startTime);

      case RecoveryAction.RECONNECT:
        return await this.reconnectBroker(context, startTime);

      case RecoveryAction.RESYNC:
        return await this.resyncData(context, startTime);

      case RecoveryAction.CLOSE_POSITIONS:
        return await this.closeAllPositions(context, startTime);

      case RecoveryAction.ACTIVATE_KILL_SWITCH:
        return await this.activateKillSwitch(context, startTime);

      case RecoveryAction.ALERT_ONLY:
        return {
          success: true,
          action: RecoveryAction.ALERT_ONLY,
          message: 'Alert sent, no automatic recovery',
          attempts: 0,
          duration: Date.now() - startTime
        };

      default:
        return {
          success: false,
          action: context.recoveryAction,
          message: 'Unknown recovery action',
          attempts: 0,
          duration: Date.now() - startTime
        };
    }
  }

  /**
   * Retry the failed operation
   */
  private async retryOperation(context: ErrorContext, startTime: number): Promise<RecoveryResult> {
    logger.info('Retrying operation', {
      component: context.component,
      operation: context.operation
    });

    // Operation-specific retry handled by caller
    // This is just a placeholder for the recovery result
    return {
      success: true,
      action: RecoveryAction.RETRY,
      message: 'Retry scheduled',
      attempts: 1,
      duration: Date.now() - startTime
    };
  }

  /**
   * Reconnect to broker
   */
  private async reconnectBroker(context: ErrorContext, startTime: number): Promise<RecoveryResult> {
    logger.info('Attempting broker reconnection');

    const result = await RetryHandler.executeWithRetry(
      async () => {
        const connected = await this.broker.connect();
        if (!connected) {
          throw new Error('Broker connection failed');
        }
        return connected;
      },
      {
        maxAttempts: 5,
        initialDelayMs: 2000,
        maxDelayMs: 30000,
        backoffMultiplier: 2
      }
    );

    return {
      success: result.success,
      action: RecoveryAction.RECONNECT,
      message: result.success ? 'Broker reconnected' : 'Reconnection failed',
      attempts: result.attempts,
      duration: Date.now() - startTime
    };
  }

  /**
   * Resync positions and orders
   */
  private async resyncData(context: ErrorContext, startTime: number): Promise<RecoveryResult> {
    logger.info('Resyncing data with broker');

    try {
      await this.positionManager.syncPositions();

      return {
        success: true,
        action: RecoveryAction.RESYNC,
        message: 'Data resynced successfully',
        attempts: 1,
        duration: Date.now() - startTime
      };
    } catch (error: any) {
      logger.error('Resync failed', error);
      return {
        success: false,
        action: RecoveryAction.RESYNC,
        message: `Resync failed: ${error.message}`,
        attempts: 1,
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Close all positions (emergency)
   */
  private async closeAllPositions(context: ErrorContext, startTime: number): Promise<RecoveryResult> {
    logger.warn('Emergency: Closing all positions');

    const positions = this.positionManager.getAllPositions();
    let closedCount = 0;

    for (const position of positions) {
      try {
        const side = position.type === 'LONG' ? 'SELL' : 'BUY';
        await this.broker.placeOrder(
          position.symbol,
          side as any,
          'MARKET' as any,
          position.quantity
        );
        closedCount++;
      } catch (error: any) {
        logger.error('Failed to close position', {
          symbol: position.symbol,
          error: error.message
        });
      }
    }

    return {
      success: closedCount === positions.length,
      action: RecoveryAction.CLOSE_POSITIONS,
      message: `Closed ${closedCount}/${positions.length} positions`,
      attempts: 1,
      duration: Date.now() - startTime
    };
  }

  /**
   * Activate kill switch (stop all trading)
   */
  private async activateKillSwitch(context: ErrorContext, startTime: number): Promise<RecoveryResult> {
    logger.error('CRITICAL ERROR: Activating kill switch');

    const configManager = (await import('../config')).default;
    configManager.setKillSwitch(true);

    return {
      success: true,
      action: RecoveryAction.ACTIVATE_KILL_SWITCH,
      message: 'Kill switch activated',
      attempts: 1,
      duration: Date.now() - startTime
    };
  }

  /**
   * Recover broker connection with exponential backoff
   */
  private async recoverBrokerConnection(): Promise<void> {
    logger.info('Initiating broker connection recovery');

    const result = await RetryHandler.executeWithRetry(
      async () => {
        await this.broker.disconnect();
        await new Promise(resolve => setTimeout(resolve, 2000));
        const connected = await this.broker.connect();

        if (!connected) {
          throw new Error('Broker connection failed');
        }

        // Resync after reconnection
        await this.positionManager.syncPositions();

        return true;
      },
      {
        maxAttempts: 10,
        initialDelayMs: 5000,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
        onRetry: (attempt, error) => {
          logger.warn('Broker connection retry', { attempt, error: error.message });
        }
      }
    );

    if (result.success) {
      logger.info('Broker connection recovered successfully');
      this.brokerConnectionBreaker.close();
    } else {
      logger.error('Broker connection recovery failed after all retries');
      this.emit('broker_connection_failed', result);
    }
  }

  // Error type detection methods
  private isNetworkError(error: any): boolean {
    const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'];
    return networkCodes.includes(error.code);
  }

  private isAuthError(error: any): boolean {
    return error.statusCode === 401 || error.message?.includes('authentication') || error.message?.includes('unauthorized');
  }

  private isRateLimitError(error: any): boolean {
    return error.statusCode === 429 || error.message?.includes('rate limit');
  }

  private isOrderRejectionError(error: any): boolean {
    return error.message?.includes('rejected') || error.message?.includes('insufficient');
  }

  private isPositionError(error: any): boolean {
    return error.message?.includes('position') && error.message?.includes('mismatch');
  }

  private isDataSyncError(error: any): boolean {
    return error.message?.includes('sync') || error.message?.includes('stale data');
  }

  private isCriticalError(error: any): boolean {
    return error.message?.includes('critical') || error.message?.includes('fatal');
  }

  /**
   * Record error in history
   */
  private recordError(context: ErrorContext): void {
    this.errorHistory.push(context);

    // Trim history if too large
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory = this.errorHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get error statistics
   */
  public getErrorStats() {
    const now = Date.now();
    const last15Min = this.errorHistory.filter(e => now - e.timestamp.getTime() < 15 * 60 * 1000);
    const lastHour = this.errorHistory.filter(e => now - e.timestamp.getTime() < 60 * 60 * 1000);

    const bySeverity = {
      low: this.errorHistory.filter(e => e.severity === ErrorSeverity.LOW).length,
      medium: this.errorHistory.filter(e => e.severity === ErrorSeverity.MEDIUM).length,
      high: this.errorHistory.filter(e => e.severity === ErrorSeverity.HIGH).length,
      critical: this.errorHistory.filter(e => e.severity === ErrorSeverity.CRITICAL).length
    };

    return {
      totalErrors: this.errorHistory.length,
      last15Minutes: last15Min.length,
      lastHour: lastHour.length,
      bySeverity: bySeverity,
      circuitBreakers: {
        orderPlacement: this.orderPlacementBreaker.getStats(),
        dataFetch: this.dataFetchBreaker.getStats(),
        brokerConnection: this.brokerConnectionBreaker.getStats()
      }
    };
  }

  /**
   * Get circuit breakers
   */
  public getCircuitBreakers() {
    return {
      orderPlacement: this.orderPlacementBreaker,
      dataFetch: this.dataFetchBreaker,
      brokerConnection: this.brokerConnectionBreaker
    };
  }
}
