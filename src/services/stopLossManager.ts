import { EventEmitter } from 'events';
import { IBroker } from '../brokers/base';
import { Order, OrderSide, OrderType, Position } from '../types';
import { logger } from '../utils/logger';
import { orderStateManager } from './orderStateManager';

interface StopLossOrder {
  symbol: string;
  entryOrderId: string;
  stopLossOrderId?: string;
  targetOrderId?: string;
  stopLossPrice: number;
  targetPrice?: number;
  quantity: number;
  side: OrderSide; // Side of the exit order (opposite of entry)
  isPlaced: boolean;
  isTriggered: boolean;
  createdAt: Date;
}

/**
 * Stop Loss Manager - Places REAL stop-loss orders at broker level
 * Ensures protection even if bot crashes
 */
export class StopLossManager extends EventEmitter {
  private broker: IBroker;
  private stopLossOrders: Map<string, StopLossOrder> = new Map();
  private monitorInterval: NodeJS.Timeout | null = null;
  private readonly MONITOR_INTERVAL_MS = 10000; // Check every 10 seconds

  constructor(broker: IBroker) {
    super();
    this.broker = broker;
  }

  /**
   * Place broker-level stop-loss order after entry order fills
   */
  public async placeStopLoss(
    symbol: string,
    entryOrderId: string,
    position: Position,
    stopLossPrice: number,
    targetPrice?: number
  ): Promise<boolean> {
    try {
      // Determine exit side (opposite of entry)
      const exitSide = position.type === 'LONG' ? OrderSide.SELL : OrderSide.BUY;

      logger.info('📍 Placing broker-level stop-loss order', {
        symbol,
        entryOrderId,
        positionType: position.type,
        quantity: position.quantity,
        stopLossPrice: `₹${stopLossPrice.toFixed(2)}`,
        targetPrice: targetPrice ? `₹${targetPrice.toFixed(2)}` : 'None'
      });

      // Place stop-loss order at broker
      const stopLossOrder = await this.broker.placeOrder(
        symbol,
        exitSide,
        OrderType.STOP_LOSS_MARKET,
        position.quantity,
        undefined, // No limit price for SL-M
        stopLossPrice
      );

      if (!stopLossOrder) {
        logger.error('❌ Failed to place broker-level stop-loss', { symbol });
        return false;
      }

      const slRecord: StopLossOrder = {
        symbol,
        entryOrderId,
        stopLossOrderId: stopLossOrder.orderId,
        stopLossPrice,
        targetPrice,
        quantity: position.quantity,
        side: exitSide,
        isPlaced: true,
        isTriggered: false,
        createdAt: new Date()
      };

      this.stopLossOrders.set(symbol, slRecord);

      // Link to parent order in state manager
      orderStateManager.linkChildOrder(entryOrderId, stopLossOrder.orderId);

      logger.info('✅ Broker-level stop-loss placed successfully', {
        symbol,
        stopLossOrderId: stopLossOrder.orderId,
        stopLossPrice: `₹${stopLossPrice.toFixed(2)}`
      });

      logger.audit('STOP_LOSS_PLACED', slRecord);

      this.emit('stop_loss_placed', slRecord);

      // Optionally place target order (bracket order)
      if (targetPrice) {
        await this.placeTargetOrder(symbol, entryOrderId, position, targetPrice, stopLossOrder.orderId);
      }

      return true;

    } catch (error: any) {
      logger.error('Error placing broker-level stop-loss', {
        symbol,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Place target/profit-taking order
   */
  private async placeTargetOrder(
    symbol: string,
    entryOrderId: string,
    position: Position,
    targetPrice: number,
    stopLossOrderId: string
  ): Promise<void> {
    try {
      const exitSide = position.type === 'LONG' ? OrderSide.SELL : OrderSide.BUY;

      logger.info('🎯 Placing target order', {
        symbol,
        targetPrice: `₹${targetPrice.toFixed(2)}`
      });

      const targetOrder = await this.broker.placeOrder(
        symbol,
        exitSide,
        OrderType.LIMIT,
        position.quantity,
        targetPrice
      );

      if (targetOrder) {
        const slRecord = this.stopLossOrders.get(symbol);
        if (slRecord) {
          slRecord.targetOrderId = targetOrder.orderId;
        }

        // Link to parent order
        orderStateManager.linkChildOrder(entryOrderId, targetOrder.orderId);

        logger.info('✅ Target order placed successfully', {
          symbol,
          targetOrderId: targetOrder.orderId
        });

        this.emit('target_order_placed', {
          symbol,
          targetOrderId: targetOrder.orderId,
          targetPrice
        });
      }

    } catch (error: any) {
      logger.error('Error placing target order', {
        symbol,
        error: error.message
      });
    }
  }

  /**
   * Cancel stop-loss order (when position is closed or target hit)
   */
  public async cancelStopLoss(symbol: string, reason: string): Promise<void> {
    const slRecord = this.stopLossOrders.get(symbol);
    if (!slRecord) {
      return;
    }

    try {
      logger.info('🚫 Cancelling stop-loss order', {
        symbol,
        reason,
        stopLossOrderId: slRecord.stopLossOrderId
      });

      // Cancel stop-loss order
      if (slRecord.stopLossOrderId) {
        await this.broker.cancelOrder(slRecord.stopLossOrderId);
      }

      // Cancel target order if exists
      if (slRecord.targetOrderId) {
        await this.broker.cancelOrder(slRecord.targetOrderId);
      }

      this.stopLossOrders.delete(symbol);

      logger.info('✅ Stop-loss order cancelled', { symbol });
      this.emit('stop_loss_cancelled', { symbol, reason });

    } catch (error: any) {
      logger.error('Error cancelling stop-loss order', {
        symbol,
        error: error.message
      });
    }
  }

  /**
   * Update stop-loss price (trailing stop)
   */
  public async updateStopLoss(
    symbol: string,
    newStopLossPrice: number
  ): Promise<boolean> {
    const slRecord = this.stopLossOrders.get(symbol);
    if (!slRecord || !slRecord.stopLossOrderId) {
      logger.warn('Cannot update non-existent stop-loss', { symbol });
      return false;
    }

    try {
      // Cancel old stop-loss
      await this.broker.cancelOrder(slRecord.stopLossOrderId);

      // Place new stop-loss
      const newStopLossOrder = await this.broker.placeOrder(
        symbol,
        slRecord.side,
        OrderType.STOP_LOSS_MARKET,
        slRecord.quantity,
        undefined,
        newStopLossPrice
      );

      if (newStopLossOrder) {
        slRecord.stopLossOrderId = newStopLossOrder.orderId;
        slRecord.stopLossPrice = newStopLossPrice;

        logger.info('✅ Stop-loss updated', {
          symbol,
          oldPrice: slRecord.stopLossPrice,
          newPrice: newStopLossPrice,
          newOrderId: newStopLossOrder.orderId
        });

        this.emit('stop_loss_updated', {
          symbol,
          newStopLossPrice
        });

        return true;
      }

      return false;

    } catch (error: any) {
      logger.error('Error updating stop-loss', {
        symbol,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Start monitoring stop-loss orders
   */
  public startMonitoring(): void {
    if (this.monitorInterval) {
      logger.warn('Stop-loss monitoring already running');
      return;
    }

    logger.info('🔍 Starting stop-loss order monitoring...');

    this.monitorInterval = setInterval(async () => {
      await this.checkStopLossOrders();
    }, this.MONITOR_INTERVAL_MS);

    logger.info('✅ Stop-loss monitoring started');
  }

  /**
   * Stop monitoring
   */
  public stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      logger.info('✅ Stop-loss monitoring stopped');
    }
  }

  /**
   * Check status of all stop-loss orders
   */
  private async checkStopLossOrders(): Promise<void> {
    try {
      const orders = await this.broker.getOrders();
      const orderMap = new Map(orders.map(o => [o.orderId, o]));

      for (const [symbol, slRecord] of this.stopLossOrders) {
        // Check stop-loss order status
        if (slRecord.stopLossOrderId) {
          const slOrder = orderMap.get(slRecord.stopLossOrderId);

          if (slOrder && slOrder.status === 'FILLED') {
            logger.warn('⚠️  Stop-loss triggered at broker', {
              symbol,
              stopLossPrice: `₹${slRecord.stopLossPrice.toFixed(2)}`
            });

            slRecord.isTriggered = true;
            this.emit('stop_loss_triggered', slRecord);

            // Cancel target order if exists
            if (slRecord.targetOrderId) {
              await this.broker.cancelOrder(slRecord.targetOrderId);
            }

            this.stopLossOrders.delete(symbol);
          }
        }

        // Check target order status
        if (slRecord.targetOrderId) {
          const targetOrder = orderMap.get(slRecord.targetOrderId);

          if (targetOrder && targetOrder.status === 'FILLED') {
            logger.info('🎯 Target hit at broker', { symbol });

            this.emit('target_hit', slRecord);

            // Cancel stop-loss order
            if (slRecord.stopLossOrderId) {
              await this.broker.cancelOrder(slRecord.stopLossOrderId);
            }

            this.stopLossOrders.delete(symbol);
          }
        }
      }

    } catch (error: any) {
      logger.error('Error checking stop-loss orders', error);
    }
  }

  /**
   * Get all active stop-loss orders
   */
  public getActiveStopLosses(): StopLossOrder[] {
    return Array.from(this.stopLossOrders.values());
  }

  /**
   * Get stop-loss for specific symbol
   */
  public getStopLoss(symbol: string): StopLossOrder | undefined {
    return this.stopLossOrders.get(symbol);
  }

  /**
   * Check if symbol has active stop-loss
   */
  public hasStopLoss(symbol: string): boolean {
    return this.stopLossOrders.has(symbol);
  }

  /**
   * Cancel all stop-loss orders (emergency use)
   */
  public async cancelAllStopLosses(reason: string = 'Emergency cancellation'): Promise<void> {
    logger.warn('⚠️  Cancelling all stop-loss orders', { reason });

    const symbols = Array.from(this.stopLossOrders.keys());

    for (const symbol of symbols) {
      await this.cancelStopLoss(symbol, reason);
    }

    logger.info('✅ All stop-loss orders cancelled', {
      count: symbols.length
    });
  }

  /**
   * Get statistics
   */
  public getStatistics() {
    const orders = Array.from(this.stopLossOrders.values());

    return {
      active: orders.length,
      withTargets: orders.filter(o => o.targetOrderId).length,
      triggered: orders.filter(o => o.isTriggered).length
    };
  }
}
