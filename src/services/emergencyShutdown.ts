import { EventEmitter } from 'events';
import { TradingEngine } from '../core/tradingEngine';
import { IBroker } from '../brokers/base';
import { PositionManager } from '../core/positionManager';
import { logger } from '../utils/logger';
import configManager from '../config';

export enum ShutdownReason {
  MANUAL = 'MANUAL',
  DAILY_LOSS_LIMIT = 'DAILY_LOSS_LIMIT',
  SYSTEM_ERROR = 'SYSTEM_ERROR',
  MARKET_CLOSED = 'MARKET_CLOSED',
  BROKER_DISCONNECTED = 'BROKER_DISCONNECTED',
  RISK_BREACH = 'RISK_BREACH',
  KILL_SWITCH = 'KILL_SWITCH'
}

interface ShutdownContext {
  reason: ShutdownReason;
  message: string;
  closePositions: boolean;
  cancelOrders: boolean;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  timestamp: Date;
}

export class EmergencyShutdownService extends EventEmitter {
  private engine: TradingEngine | null = null;
  private broker: IBroker | null = null;
  private positionManager: PositionManager | null = null;
  private isShuttingDown: boolean = false;
  private shutdownHistory: ShutdownContext[] = [];
  private maxHistorySize: number = 100;

  constructor() {
    super();
    this.setupProcessHandlers();
  }

  public initialize(
    engine: TradingEngine,
    broker: IBroker,
    positionManager: PositionManager
  ): void {
    this.engine = engine;
    this.broker = broker;
    this.positionManager = positionManager;

    logger.info('Emergency shutdown service initialized');
  }

  private setupProcessHandlers(): void {
    // Handle uncaught exceptions
    process.on('uncaughtException', async (error: Error) => {
      logger.error('Uncaught exception detected', error);

      await this.triggerEmergencyShutdown({
        reason: ShutdownReason.SYSTEM_ERROR,
        message: `Uncaught exception: ${error.message}`,
        closePositions: true,
        cancelOrders: true,
        severity: 'CRITICAL',
        timestamp: new Date()
      });

      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', async (reason: any) => {
      logger.error('Unhandled promise rejection', { reason });

      await this.triggerEmergencyShutdown({
        reason: ShutdownReason.SYSTEM_ERROR,
        message: `Unhandled rejection: ${reason}`,
        closePositions: true,
        cancelOrders: true,
        severity: 'CRITICAL',
        timestamp: new Date()
      });

      process.exit(1);
    });

    // Handle SIGTERM
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received - initiating graceful shutdown');

      await this.triggerEmergencyShutdown({
        reason: ShutdownReason.MANUAL,
        message: 'SIGTERM signal received',
        closePositions: true,
        cancelOrders: true,
        severity: 'MEDIUM',
        timestamp: new Date()
      });

      process.exit(0);
    });

    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', async () => {
      logger.info('SIGINT received - initiating graceful shutdown');

      await this.triggerEmergencyShutdown({
        reason: ShutdownReason.MANUAL,
        message: 'SIGINT signal received',
        closePositions: true,
        cancelOrders: true,
        severity: 'MEDIUM',
        timestamp: new Date()
      });

      process.exit(0);
    });
  }

  public async triggerEmergencyShutdown(context: ShutdownContext): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('Emergency shutdown already in progress', { reason: context.reason });
      return;
    }

    this.isShuttingDown = true;

    logger.error('EMERGENCY SHUTDOWN TRIGGERED', {
      reason: context.reason,
      message: context.message,
      severity: context.severity,
      closePositions: context.closePositions,
      cancelOrders: context.cancelOrders
    });

    logger.audit('EMERGENCY_SHUTDOWN_TRIGGERED', context);

    // Add to history
    this.shutdownHistory.push(context);
    if (this.shutdownHistory.length > this.maxHistorySize) {
      this.shutdownHistory.shift();
    }

    this.emit('shutdown_started', context);

    try {
      // Step 1: Activate kill switch
      logger.info('Step 1/5: Activating kill switch');
      configManager.setKillSwitch(true);

      // Step 2: Cancel pending orders if requested
      if (context.cancelOrders && this.broker) {
        logger.info('Step 2/5: Cancelling all pending orders');
        await this.cancelAllPendingOrders();
      } else {
        logger.info('Step 2/5: Skipping order cancellation');
      }

      // Step 3: Close all positions if requested
      if (context.closePositions && this.positionManager) {
        logger.info('Step 3/5: Closing all positions');
        await this.closeAllPositions(context.reason);
      } else {
        logger.info('Step 3/5: Skipping position closure');
      }

      // Step 4: Stop the trading engine
      if (this.engine) {
        logger.info('Step 4/5: Stopping trading engine');
        await this.engine.stop();
      } else {
        logger.info('Step 4/5: Trading engine not initialized');
      }

      // Step 5: Generate shutdown report
      logger.info('Step 5/5: Generating shutdown report');
      await this.generateShutdownReport(context);

      logger.info('Emergency shutdown completed successfully');
      logger.audit('EMERGENCY_SHUTDOWN_COMPLETED', {
        reason: context.reason,
        duration: Date.now() - context.timestamp.getTime()
      });

      this.emit('shutdown_completed', context);
    } catch (error: any) {
      logger.error('Error during emergency shutdown', error);
      logger.audit('EMERGENCY_SHUTDOWN_ERROR', {
        reason: context.reason,
        error: error.message
      });

      this.emit('shutdown_error', { context, error });
    } finally {
      this.isShuttingDown = false;
    }
  }

  private async cancelAllPendingOrders(): Promise<void> {
    if (!this.broker) {
      logger.warn('Broker not available for order cancellation');
      return;
    }

    try {
      const orders = await this.broker.getOrders();
      const pendingOrders = orders.filter(
        order => order.status === 'PENDING' || order.status === 'SUBMITTED'
      );

      logger.info('Cancelling pending orders', { count: pendingOrders.length });

      let cancelledCount = 0;
      let failedCount = 0;

      for (const order of pendingOrders) {
        try {
          const success = await this.broker.cancelOrder(order.orderId);
          if (success) {
            cancelledCount++;
            logger.info('Order cancelled', { orderId: order.orderId, symbol: order.symbol });
          } else {
            failedCount++;
            logger.warn('Failed to cancel order', { orderId: order.orderId, symbol: order.symbol });
          }
        } catch (error: any) {
          failedCount++;
          logger.error('Error cancelling order', { orderId: order.orderId, error: error.message });
        }

        // Add small delay between cancellations to avoid rate limiting
        await this.delay(200);
      }

      logger.info('Order cancellation completed', {
        total: pendingOrders.length,
        cancelled: cancelledCount,
        failed: failedCount
      });

      logger.audit('ORDERS_CANCELLED', {
        total: pendingOrders.length,
        cancelled: cancelledCount,
        failed: failedCount
      });
    } catch (error: any) {
      logger.error('Error getting orders for cancellation', error);
    }
  }

  private async closeAllPositions(reason: ShutdownReason): Promise<void> {
    if (!this.positionManager || !this.broker) {
      logger.warn('Position manager or broker not available');
      return;
    }

    try {
      const positions = this.positionManager.getAllPositions();

      logger.info('Closing all positions', {
        count: positions.length,
        reason: reason
      });

      let closedCount = 0;
      let failedCount = 0;

      for (const position of positions) {
        try {
          const side = position.type === 'LONG' ? 'SELL' : 'BUY';

          const order = await this.broker.placeOrder(
            position.symbol,
            side as any,
            'MARKET' as any,
            position.quantity
          );

          if (order) {
            closedCount++;
            logger.info('Position close order placed', {
              symbol: position.symbol,
              quantity: position.quantity,
              orderId: order.orderId
            });
          } else {
            failedCount++;
            logger.error('Failed to place position close order', {
              symbol: position.symbol
            });
          }
        } catch (error: any) {
          failedCount++;
          logger.error('Error closing position', {
            symbol: position.symbol,
            error: error.message
          });
        }

        // Add delay to avoid rate limiting
        await this.delay(500);
      }

      logger.info('Position closure completed', {
        total: positions.length,
        closed: closedCount,
        failed: failedCount
      });

      logger.audit('POSITIONS_CLOSED', {
        reason: reason,
        total: positions.length,
        closed: closedCount,
        failed: failedCount
      });
    } catch (error: any) {
      logger.error('Error closing positions', error);
    }
  }

  private async generateShutdownReport(context: ShutdownContext): Promise<void> {
    try {
      const report = {
        shutdownContext: context,
        systemState: {
          positionsCount: this.positionManager?.getAllPositions().length || 0,
          killSwitchActive: configManager.isKillSwitchActive(),
          mode: configManager.getTradingMode()
        },
        timestamp: new Date().toISOString()
      };

      logger.info('Shutdown Report', report);
      logger.audit('SHUTDOWN_REPORT', report);

      this.emit('shutdown_report', report);
    } catch (error: any) {
      logger.error('Error generating shutdown report', error);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  public async shutdownForDailyLossLimit(): Promise<void> {
    await this.triggerEmergencyShutdown({
      reason: ShutdownReason.DAILY_LOSS_LIMIT,
      message: 'Daily loss limit exceeded',
      closePositions: true,
      cancelOrders: true,
      severity: 'HIGH',
      timestamp: new Date()
    });
  }

  public async shutdownForBrokerDisconnection(): Promise<void> {
    await this.triggerEmergencyShutdown({
      reason: ShutdownReason.BROKER_DISCONNECTED,
      message: 'Broker connection lost',
      closePositions: false, // Can't close if disconnected
      cancelOrders: false,
      severity: 'CRITICAL',
      timestamp: new Date()
    });
  }

  public async shutdownForMarketClose(): Promise<void> {
    await this.triggerEmergencyShutdown({
      reason: ShutdownReason.MARKET_CLOSED,
      message: 'Market closed - auto square off',
      closePositions: true,
      cancelOrders: true,
      severity: 'LOW',
      timestamp: new Date()
    });
  }

  public async shutdownForKillSwitch(): Promise<void> {
    await this.triggerEmergencyShutdown({
      reason: ShutdownReason.KILL_SWITCH,
      message: 'Kill switch activated',
      closePositions: true,
      cancelOrders: true,
      severity: 'HIGH',
      timestamp: new Date()
    });
  }

  public getShutdownHistory(): ShutdownContext[] {
    return [...this.shutdownHistory];
  }

  public isInShutdownMode(): boolean {
    return this.isShuttingDown;
  }
}

// Singleton instance
export const emergencyShutdown = new EmergencyShutdownService();
