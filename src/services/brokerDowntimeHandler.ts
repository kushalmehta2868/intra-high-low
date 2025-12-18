import { EventEmitter } from 'events';
import { IBroker } from '../brokers/base';
import { PositionManager } from '../core/positionManager';
import { logger } from '../utils/logger';
import { RetryHandler } from '../utils/retry';
import configManager from '../config';

export enum BrokerHealthStatus {
  HEALTHY = 'HEALTHY',
  DEGRADED = 'DEGRADED',
  DOWN = 'DOWN',
  RECOVERING = 'RECOVERING'
}

export interface BrokerHealthCheck {
  timestamp: Date;
  status: BrokerHealthStatus;
  responseTimeMs: number;
  consecutiveFailures: number;
  lastError?: string;
}

export interface DowntimeEvent {
  startTime: Date;
  endTime?: Date;
  durationMs?: number;
  reason: string;
  impactedOperations: string[];
}

export class BrokerDowntimeHandler extends EventEmitter {
  private broker: IBroker;
  private positionManager: PositionManager;
  private currentStatus: BrokerHealthStatus = BrokerHealthStatus.HEALTHY;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckIntervalMs: number = 30000; // 30 seconds
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;
  private failureThreshold: number = 3;
  private recoveryThreshold: number = 2;
  private healthHistory: BrokerHealthCheck[] = [];
  private downtimeEvents: DowntimeEvent[] = [];
  private currentDowntime: DowntimeEvent | null = null;
  private isMonitoring: boolean = false;
  private degradedModeActive: boolean = false;

  // Cached data during downtime
  private cachedPositions: any[] = [];
  private cachedBalance: number = 0;
  private lastSuccessfulSync: Date | null = null;

  constructor(broker: IBroker, positionManager: PositionManager) {
    super();
    this.broker = broker;
    this.positionManager = positionManager;
  }

  /**
   * Start monitoring broker health
   */
  public startMonitoring(): void {
    if (this.isMonitoring) {
      logger.warn('Broker health monitoring already active');
      return;
    }

    this.isMonitoring = true;

    this.healthCheckInterval = setInterval(
      () => this.performHealthCheck(),
      this.healthCheckIntervalMs
    );

    logger.info('Broker health monitoring started', {
      intervalMs: this.healthCheckIntervalMs,
      failureThreshold: this.failureThreshold
    });

    logger.audit('BROKER_MONITORING_STARTED', {});

    // Perform initial health check
    this.performHealthCheck();
  }

  /**
   * Stop monitoring
   */
  public stopMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    this.isMonitoring = false;

    logger.info('Broker health monitoring stopped');
    logger.audit('BROKER_MONITORING_STOPPED', {});
  }

  /**
   * Perform health check
   */
  private async performHealthCheck(): Promise<void> {
    const startTime = Date.now();

    try {
      // Try to fetch account balance as health check
      const balance = await this.broker.getAccountBalance();

      const responseTime = Date.now() - startTime;

      if (balance !== null && balance >= 0) {
        this.onHealthCheckSuccess(responseTime);
      } else {
        throw new Error('Invalid balance response');
      }
    } catch (error: any) {
      this.onHealthCheckFailure(error, Date.now() - startTime);
    }
  }

  /**
   * Handle successful health check
   */
  private onHealthCheckSuccess(responseTimeMs: number): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;

    const healthCheck: BrokerHealthCheck = {
      timestamp: new Date(),
      status: BrokerHealthStatus.HEALTHY,
      responseTimeMs: responseTimeMs,
      consecutiveFailures: 0
    };

    this.recordHealthCheck(healthCheck);

    // Check if we're recovering from downtime
    if (this.currentStatus === BrokerHealthStatus.DOWN ||
        this.currentStatus === BrokerHealthStatus.RECOVERING) {

      if (this.consecutiveSuccesses >= this.recoveryThreshold) {
        this.onBrokerRecovered();
      } else {
        this.updateStatus(BrokerHealthStatus.RECOVERING);
      }
    } else if (this.currentStatus === BrokerHealthStatus.DEGRADED) {
      if (this.consecutiveSuccesses >= this.recoveryThreshold) {
        this.updateStatus(BrokerHealthStatus.HEALTHY);
        this.degradedModeActive = false;
      }
    }

    // Detect slow responses (degraded performance)
    if (responseTimeMs > 5000 && this.currentStatus === BrokerHealthStatus.HEALTHY) {
      logger.warn('Broker response time degraded', { responseTimeMs });
      this.updateStatus(BrokerHealthStatus.DEGRADED);
      this.degradedModeActive = true;
    }
  }

  /**
   * Handle failed health check
   */
  private onHealthCheckFailure(error: any, responseTimeMs: number): void {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;

    const healthCheck: BrokerHealthCheck = {
      timestamp: new Date(),
      status: BrokerHealthStatus.DOWN,
      responseTimeMs: responseTimeMs,
      consecutiveFailures: this.consecutiveFailures,
      lastError: error.message
    };

    this.recordHealthCheck(healthCheck);

    logger.error('Broker health check failed', {
      consecutiveFailures: this.consecutiveFailures,
      error: error.message
    });

    // Trigger downtime if threshold reached
    if (this.consecutiveFailures >= this.failureThreshold &&
        this.currentStatus !== BrokerHealthStatus.DOWN) {
      this.onBrokerDown(error.message);
    }
  }

  /**
   * Handle broker down event
   */
  private async onBrokerDown(reason: string): Promise<void> {
    logger.error('BROKER DOWN DETECTED', {
      reason: reason,
      consecutiveFailures: this.consecutiveFailures
    });

    logger.audit('BROKER_DOWN', {
      reason: reason,
      consecutiveFailures: this.consecutiveFailures
    });

    this.updateStatus(BrokerHealthStatus.DOWN);

    // Start downtime event
    this.currentDowntime = {
      startTime: new Date(),
      reason: reason,
      impactedOperations: ['trading', 'data_fetch', 'position_sync']
    };

    this.emit('broker_down', {
      reason: reason,
      downtime: this.currentDowntime
    });

    // Cache current state
    await this.cacheCurrentState();

    // Enter safe mode
    await this.enterSafeMode();

    // Attempt recovery
    await this.attemptRecovery();
  }

  /**
   * Handle broker recovered event
   */
  private async onBrokerRecovered(): Promise<void> {
    logger.info('BROKER RECOVERED', {
      consecutiveSuccesses: this.consecutiveSuccesses
    });

    logger.audit('BROKER_RECOVERED', {
      consecutiveSuccesses: this.consecutiveSuccesses,
      downtimeDurationMs: this.currentDowntime ?
        Date.now() - this.currentDowntime.startTime.getTime() : 0
    });

    this.updateStatus(BrokerHealthStatus.HEALTHY);
    this.degradedModeActive = false;

    // End downtime event
    if (this.currentDowntime) {
      this.currentDowntime.endTime = new Date();
      this.currentDowntime.durationMs =
        this.currentDowntime.endTime.getTime() - this.currentDowntime.startTime.getTime();

      this.downtimeEvents.push(this.currentDowntime);
      this.currentDowntime = null;
    }

    this.emit('broker_recovered', {
      status: this.currentStatus
    });

    // Exit safe mode and resync
    await this.exitSafeMode();
  }

  /**
   * Cache current state before downtime
   */
  private async cacheCurrentState(): Promise<void> {
    try {
      this.cachedPositions = this.positionManager.getAllPositions();
      this.cachedBalance = await this.broker.getAccountBalance();
      this.lastSuccessfulSync = new Date();

      logger.info('Cached current state', {
        positionCount: this.cachedPositions.length,
        balance: this.cachedBalance
      });
    } catch (error: any) {
      logger.error('Failed to cache state', error);
    }
  }

  /**
   * Enter safe mode (stop trading, prevent new orders)
   */
  private async enterSafeMode(): Promise<void> {
    logger.warn('Entering safe mode due to broker downtime');

    // Activate kill switch to prevent new trades
    configManager.setKillSwitch(true);

    this.emit('safe_mode_activated', {
      reason: 'broker_down',
      cachedPositions: this.cachedPositions.length
    });

    logger.audit('SAFE_MODE_ACTIVATED', {
      reason: 'broker_down'
    });
  }

  /**
   * Exit safe mode after recovery
   */
  private async exitSafeMode(): Promise<void> {
    logger.info('Exiting safe mode - broker recovered');

    try {
      // Resync positions
      await this.positionManager.syncPositions();

      // Verify positions match cached state
      const currentPositions = this.positionManager.getAllPositions();

      if (currentPositions.length !== this.cachedPositions.length) {
        logger.warn('Position count mismatch after recovery', {
          cached: this.cachedPositions.length,
          current: currentPositions.length
        });

        this.emit('position_mismatch', {
          cached: this.cachedPositions,
          current: currentPositions
        });
      }

      // Deactivate kill switch if no issues
      if (currentPositions.length === this.cachedPositions.length) {
        configManager.setKillSwitch(false);
      }

      this.emit('safe_mode_deactivated', {});

      logger.audit('SAFE_MODE_DEACTIVATED', {});
    } catch (error: any) {
      logger.error('Failed to exit safe mode cleanly', error);
    }
  }

  /**
   * Attempt to recover broker connection
   */
  private async attemptRecovery(): Promise<void> {
    logger.info('Attempting broker recovery');

    this.updateStatus(BrokerHealthStatus.RECOVERING);

    const result = await RetryHandler.executeWithRetry(
      async () => {
        // Disconnect and reconnect
        await this.broker.disconnect();
        await new Promise(resolve => setTimeout(resolve, 5000));
        const connected = await this.broker.connect();

        if (!connected) {
          throw new Error('Broker connection failed');
        }

        // Test with a simple call
        const balance = await this.broker.getAccountBalance();
        if (balance === null) {
          throw new Error('Failed to fetch account balance');
        }

        return true;
      },
      {
        maxAttempts: 10,
        initialDelayMs: 10000,
        maxDelayMs: 120000,
        backoffMultiplier: 2,
        onRetry: (attempt, error) => {
          logger.warn('Broker recovery retry', {
            attempt: attempt,
            error: error.message
          });

          this.emit('recovery_attempt', {
            attempt: attempt,
            maxAttempts: 10,
            error: error.message
          });
        }
      }
    );

    if (!result.success) {
      logger.error('Broker recovery failed after all attempts');

      this.emit('recovery_failed', {
        attempts: result.attempts,
        error: result.error?.message
      });
    }
  }

  /**
   * Update broker status
   */
  private updateStatus(newStatus: BrokerHealthStatus): void {
    const oldStatus = this.currentStatus;

    if (oldStatus !== newStatus) {
      this.currentStatus = newStatus;

      logger.info('Broker status changed', {
        from: oldStatus,
        to: newStatus
      });

      this.emit('status_changed', {
        from: oldStatus,
        to: newStatus,
        timestamp: new Date()
      });
    }
  }

  /**
   * Record health check
   */
  private recordHealthCheck(check: BrokerHealthCheck): void {
    this.healthHistory.push(check);

    // Keep last 1000 checks
    if (this.healthHistory.length > 1000) {
      this.healthHistory = this.healthHistory.slice(-1000);
    }
  }

  /**
   * Check if broker is available
   */
  public isBrokerAvailable(): boolean {
    return this.currentStatus === BrokerHealthStatus.HEALTHY ||
           this.currentStatus === BrokerHealthStatus.DEGRADED;
  }

  /**
   * Check if in degraded mode
   */
  public isDegraded(): boolean {
    return this.degradedModeActive;
  }

  /**
   * Get current status
   */
  public getStatus(): BrokerHealthStatus {
    return this.currentStatus;
  }

  /**
   * Get cached positions (use during downtime)
   */
  public getCachedPositions(): any[] {
    return [...this.cachedPositions];
  }

  /**
   * Get statistics
   */
  public getStats() {
    const now = Date.now();
    const recentChecks = this.healthHistory.filter(
      c => now - c.timestamp.getTime() < 3600000 // Last hour
    );

    const avgResponseTime = recentChecks.length > 0
      ? recentChecks.reduce((sum, c) => sum + c.responseTimeMs, 0) / recentChecks.length
      : 0;

    return {
      currentStatus: this.currentStatus,
      isAvailable: this.isBrokerAvailable(),
      isDegraded: this.isDegraded(),
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastSuccessfulSync: this.lastSuccessfulSync,
      cachedPositionsCount: this.cachedPositions.length,
      downtimeEvents: this.downtimeEvents.length,
      currentDowntime: this.currentDowntime,
      recentHealthChecks: recentChecks.length,
      avgResponseTimeMs: Math.round(avgResponseTime)
    };
  }

  /**
   * Force health check
   */
  public async forceHealthCheck(): Promise<void> {
    await this.performHealthCheck();
  }
}
