import { EventEmitter } from 'events';
import { IBroker } from '../brokers/base';
import { Order, OrderStatus } from '../types';
import { logger } from '../utils/logger';

interface OrderState {
  order: Order;
  lastChecked: Date;
  checkCount: number;
}

export class OrderReconciliationService extends EventEmitter {
  private broker: IBroker;
  private pendingOrders: Map<string, OrderState> = new Map();
  private reconciliationInterval: NodeJS.Timeout | null = null;
  private checkIntervalMs: number = 5000; // 5 seconds
  private maxCheckCount: number = 60; // Max 5 minutes (60 * 5s)
  private isRunning: boolean = false;

  constructor(broker: IBroker) {
    super();
    this.broker = broker;
  }

  public start(): void {
    if (this.isRunning) {
      logger.warn('Order reconciliation already running');
      return;
    }

    this.isRunning = true;
    this.reconciliationInterval = setInterval(
      () => this.reconcilePendingOrders(),
      this.checkIntervalMs
    );

    logger.info('Order reconciliation service started', {
      intervalMs: this.checkIntervalMs,
      maxCheckCount: this.maxCheckCount
    });

    logger.audit('ORDER_RECONCILIATION_STARTED', {});
  }

  public stop(): void {
    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
    }

    this.isRunning = false;

    logger.info('Order reconciliation service stopped', {
      pendingOrdersCount: this.pendingOrders.size
    });

    logger.audit('ORDER_RECONCILIATION_STOPPED', {
      pendingOrdersCount: this.pendingOrders.size
    });
  }

  public trackOrder(order: Order): void {
    if (this.isPendingStatus(order.status)) {
      this.pendingOrders.set(order.orderId, {
        order: order,
        lastChecked: new Date(),
        checkCount: 0
      });

      logger.info('Tracking order for reconciliation', {
        orderId: order.orderId,
        symbol: order.symbol,
        status: order.status
      });
    }
  }

  public removeOrder(orderId: string): void {
    if (this.pendingOrders.has(orderId)) {
      this.pendingOrders.delete(orderId);
      logger.debug('Removed order from reconciliation tracking', { orderId });
    }
  }

  private isPendingStatus(status: OrderStatus): boolean {
    return status === OrderStatus.PENDING ||
           status === OrderStatus.SUBMITTED ||
           status === OrderStatus.PARTIALLY_FILLED;
  }

  private async reconcilePendingOrders(): Promise<void> {
    if (this.pendingOrders.size === 0) {
      return;
    }

    logger.debug('Reconciling pending orders', {
      count: this.pendingOrders.size
    });

    try {
      const brokerOrders = await this.broker.getOrders();
      const brokerOrderMap = new Map(
        brokerOrders.map(order => [order.orderId, order])
      );

      const ordersToRemove: string[] = [];

      for (const [orderId, orderState] of this.pendingOrders.entries()) {
        orderState.checkCount++;
        orderState.lastChecked = new Date();

        const brokerOrder = brokerOrderMap.get(orderId);

        if (brokerOrder) {
          if (brokerOrder.status !== orderState.order.status) {
            logger.info('Order status changed', {
              orderId: orderId,
              oldStatus: orderState.order.status,
              newStatus: brokerOrder.status,
              symbol: brokerOrder.symbol
            });

            logger.audit('ORDER_STATUS_CHANGED', {
              orderId: orderId,
              oldStatus: orderState.order.status,
              newStatus: brokerOrder.status,
              symbol: brokerOrder.symbol
            });

            this.emit('order_update', brokerOrder);
            orderState.order = brokerOrder;

            if (!this.isPendingStatus(brokerOrder.status)) {
              ordersToRemove.push(orderId);

              if (brokerOrder.status === OrderStatus.FILLED) {
                this.emit('order_filled', brokerOrder);
              } else if (brokerOrder.status === OrderStatus.REJECTED) {
                this.emit('order_rejected', brokerOrder);
              } else if (brokerOrder.status === OrderStatus.CANCELLED) {
                this.emit('order_cancelled', brokerOrder);
              }
            }
          }

          if (brokerOrder.filledQuantity !== orderState.order.filledQuantity) {
            logger.info('Order fill quantity changed', {
              orderId: orderId,
              oldFilled: orderState.order.filledQuantity,
              newFilled: brokerOrder.filledQuantity,
              totalQuantity: brokerOrder.quantity
            });

            this.emit('order_partial_fill', brokerOrder);
            orderState.order = brokerOrder;
          }
        } else {
          logger.warn('Order not found in broker order book', {
            orderId: orderId,
            checkCount: orderState.checkCount
          });

          if (orderState.checkCount >= this.maxCheckCount) {
            logger.error('Order reconciliation max attempts reached', {
              orderId: orderId,
              symbol: orderState.order.symbol,
              checkCount: orderState.checkCount
            });

            this.emit('order_reconciliation_failed', orderState.order);
            ordersToRemove.push(orderId);
          }
        }
      }

      // Remove completed/failed orders
      for (const orderId of ordersToRemove) {
        this.pendingOrders.delete(orderId);
      }

      if (ordersToRemove.length > 0) {
        logger.info('Removed reconciled orders', {
          count: ordersToRemove.length,
          remaining: this.pendingOrders.size
        });
      }
    } catch (error: any) {
      logger.error('Error during order reconciliation', error);
      this.emit('reconciliation_error', error);
    }
  }

  public async performFullReconciliation(): Promise<void> {
    logger.info('Performing full order reconciliation');

    try {
      const brokerOrders = await this.broker.getOrders();

      for (const brokerOrder of brokerOrders) {
        if (this.isPendingStatus(brokerOrder.status)) {
          if (!this.pendingOrders.has(brokerOrder.orderId)) {
            logger.warn('Found untracked pending order', {
              orderId: brokerOrder.orderId,
              symbol: brokerOrder.symbol,
              status: brokerOrder.status
            });

            this.trackOrder(brokerOrder);
            this.emit('untracked_order_found', brokerOrder);
          }
        }
      }

      logger.info('Full order reconciliation completed', {
        brokerOrdersCount: brokerOrders.length,
        trackedOrdersCount: this.pendingOrders.size
      });

      logger.audit('FULL_ORDER_RECONCILIATION', {
        brokerOrdersCount: brokerOrders.length,
        trackedOrdersCount: this.pendingOrders.size
      });
    } catch (error: any) {
      logger.error('Error during full order reconciliation', error);
      throw error;
    }
  }

  public getPendingOrders(): Order[] {
    return Array.from(this.pendingOrders.values()).map(state => state.order);
  }

  public getPendingOrdersCount(): number {
    return this.pendingOrders.size;
  }

  public getOrderState(orderId: string): OrderState | undefined {
    return this.pendingOrders.get(orderId);
  }
}
