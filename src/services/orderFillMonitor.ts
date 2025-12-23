import { IBroker } from '../brokers/base';
import { Order, OrderStatus } from '../types';
import { logger } from '../utils/logger';

/**
 * OrderFillMonitor - Waits for order fills and handles partial fills
 *
 * Critical for:
 * - Confirming order execution before placing stop-loss
 * - Detecting partial fills (adjust SL quantity accordingly)
 * - Handling order rejections gracefully
 *
 * Without this: Partial fills can cause SL order rejections or over-exits
 */
export class OrderFillMonitor {
  private broker: IBroker;
  private readonly CHECK_INTERVAL_MS = 2000; // Check every 2 seconds
  private readonly MAX_WAIT_MS = 30000; // Wait up to 30 seconds

  constructor(broker: IBroker) {
    this.broker = broker;
  }

  /**
   * Wait for order to fill (completely or partially)
   * Returns actual filled quantity (0 if failed)
   */
  public async waitForFill(orderId: string, expectedQuantity: number): Promise<{
    filled: number;
    status: 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'TIMEOUT';
    averagePrice?: number;
  }> {
    const startTime = Date.now();

    logger.info('⏳ Waiting for order fill...', {
      orderId,
      expectedQuantity,
      maxWaitSeconds: this.MAX_WAIT_MS / 1000
    });

    while (Date.now() - startTime < this.MAX_WAIT_MS) {
      try {
        const orders = await this.broker.getOrders();
        const order = orders.find(o => o.orderId === orderId);

        if (!order) {
          logger.error('❌ Order not found in broker orderbook', { orderId });
          return { filled: 0, status: 'FAILED' };
        }

        // Check for complete fill
        if (order.status === OrderStatus.FILLED) {
          logger.info('✅ Order filled completely', {
            orderId,
            filledQuantity: order.filledQuantity,
            averagePrice: order.averagePrice
          });

          logger.audit('ORDER_FILLED', {
            orderId,
            filledQuantity: order.filledQuantity,
            averagePrice: order.averagePrice,
            waitTimeMs: Date.now() - startTime
          });

          return {
            filled: order.filledQuantity,
            status: 'COMPLETE',
            averagePrice: order.averagePrice
          };
        }

        // Check for rejection
        if (order.status === OrderStatus.REJECTED) {
          logger.error('❌ Order rejected by broker', {
            orderId,
            status: order.status,
            symbol: order.symbol
          });

          logger.audit('ORDER_REJECTED', {
            orderId,
            symbol: order.symbol
          });

          return { filled: 0, status: 'FAILED' };
        }

        // Check for cancellation
        if (order.status === OrderStatus.CANCELLED) {
          logger.warn('⚠️ Order was cancelled', {
            orderId,
            status: order.status
          });

          return { filled: 0, status: 'FAILED' };
        }

        // Check for partial fill (still waiting)
        if (order.status === OrderStatus.PARTIALLY_FILLED) {
          logger.warn('⏳ Order partially filled - waiting for complete fill', {
            orderId,
            filledQuantity: order.filledQuantity,
            totalQuantity: order.quantity,
            percentFilled: `${((order.filledQuantity / order.quantity) * 100).toFixed(1)}%`
          });
        }

        // Still pending - wait and retry
        await new Promise(resolve => setTimeout(resolve, this.CHECK_INTERVAL_MS));

      } catch (error: any) {
        logger.error('Error checking order status', {
          orderId,
          error: error.message
        });
        // Continue waiting despite error
        await new Promise(resolve => setTimeout(resolve, this.CHECK_INTERVAL_MS));
      }
    }

    // Timeout reached - check final status
    logger.warn('⏰ Order fill timeout reached - checking final status', {
      orderId,
      waitedSeconds: this.MAX_WAIT_MS / 1000
    });

    try {
      const orders = await this.broker.getOrders();
      const order = orders.find(o => o.orderId === orderId);

      if (order && order.filledQuantity > 0) {
        logger.warn('⚠️ PARTIAL FILL DETECTED after timeout', {
          orderId,
          filledQuantity: order.filledQuantity,
          expectedQuantity: expectedQuantity,
          percentFilled: `${((order.filledQuantity / expectedQuantity) * 100).toFixed(1)}%`,
          averagePrice: order.averagePrice
        });

        logger.audit('ORDER_PARTIAL_FILL', {
          orderId,
          filledQuantity: order.filledQuantity,
          expectedQuantity,
          averagePrice: order.averagePrice
        });

        return {
          filled: order.filledQuantity,
          status: 'PARTIAL',
          averagePrice: order.averagePrice
        };
      }
    } catch (error: any) {
      logger.error('Error checking final order status', {
        orderId,
        error: error.message
      });
    }

    // Complete timeout with no fill
    logger.error('❌ Order fill timeout - NO FILL', {
      orderId,
      expectedQuantity
    });

    logger.audit('ORDER_TIMEOUT', { orderId, expectedQuantity });

    return { filled: 0, status: 'TIMEOUT' };
  }

  /**
   * Quick check if order is filled (no waiting)
   */
  public async checkFillStatus(orderId: string): Promise<{
    isFilled: boolean;
    filledQuantity: number;
    status: OrderStatus;
  }> {
    try {
      const orders = await this.broker.getOrders();
      const order = orders.find(o => o.orderId === orderId);

      if (!order) {
        return {
          isFilled: false,
          filledQuantity: 0,
          status: OrderStatus.PENDING
        };
      }

      return {
        isFilled: order.status === OrderStatus.FILLED,
        filledQuantity: order.filledQuantity,
        status: order.status
      };
    } catch (error: any) {
      logger.error('Error checking fill status', {
        orderId,
        error: error.message
      });

      return {
        isFilled: false,
        filledQuantity: 0,
        status: OrderStatus.PENDING
      };
    }
  }
}
