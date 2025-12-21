import { EventEmitter } from 'events';
import { Order, OrderStatus, OrderSide } from '../types';
import { logger } from '../utils/logger';

export enum OrderState {
  CREATED = 'CREATED',
  PENDING = 'PENDING',
  SUBMITTED = 'SUBMITTED',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED'
}

interface OrderStateRecord extends Order {
  state: OrderState;
  stateHistory: OrderStateTransition[];
  createdAt: Date;
  lastUpdatedAt: Date;
  retryCount: number;
  errorMessage?: string;
  parentOrderId?: string; // For linking stop-loss orders to entry orders
  childOrderIds?: string[]; // For tracking stop-loss/target orders
}

interface OrderStateTransition {
  fromState: OrderState;
  toState: OrderState;
  timestamp: Date;
  reason?: string;
}

/**
 * Order State Manager - Tracks complete order lifecycle with state machine
 * Handles partial fills, rejections, retries, and order relationships
 */
export class OrderStateManager extends EventEmitter {
  private orders: Map<string, OrderStateRecord> = new Map();
  private pendingOrders: Map<string, NodeJS.Timeout> = new Map();
  private readonly MAX_RETRY_COUNT = 3;
  private readonly ORDER_TIMEOUT_MS = 60000; // 1 minute timeout for orders

  /**
   * Create a new order and track its state
   */
  public createOrder(order: Order): OrderStateRecord {
    const stateRecord: OrderStateRecord = {
      ...order,
      state: OrderState.CREATED,
      stateHistory: [],
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
      retryCount: 0,
      childOrderIds: []
    };

    this.orders.set(order.orderId, stateRecord);
    this.transitionState(order.orderId, OrderState.PENDING, 'Order created');

    // Set timeout for order
    this.setPendingOrderTimeout(order.orderId);

    logger.info('📝 Order created and tracked', {
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity
    });

    logger.audit('ORDER_CREATED', stateRecord);

    return stateRecord;
  }

  /**
   * Update order state based on broker response
   */
  public updateOrderState(orderId: string, newStatus: OrderStatus, filledQuantity?: number): void {
    const order = this.orders.get(orderId);
    if (!order) {
      logger.warn('Attempted to update unknown order', { orderId });
      return;
    }

    // Map OrderStatus to OrderState
    const newState = this.mapStatusToState(newStatus, filledQuantity, order.quantity);

    if (newState !== order.state) {
      this.transitionState(orderId, newState, `Broker status: ${newStatus}`);
    }

    // Update filled quantity
    if (filledQuantity !== undefined) {
      order.filledQuantity = filledQuantity;
    }

    order.status = newStatus;
    order.lastUpdatedAt = new Date();

    // Clear timeout if order is in terminal state
    if (this.isTerminalState(newState)) {
      this.clearPendingOrderTimeout(orderId);
      this.emit('order_completed', order);
    }

    // Emit specific events based on state
    this.emitStateEvents(order);
  }

  /**
   * Mark order as submitted to broker
   */
  public markOrderSubmitted(orderId: string): void {
    this.transitionState(orderId, OrderState.SUBMITTED, 'Order submitted to broker');
  }

  /**
   * Mark order as acknowledged by broker
   */
  public markOrderAcknowledged(orderId: string, brokerOrderId?: string): void {
    const order = this.orders.get(orderId);
    if (order && brokerOrderId) {
      order.orderId = brokerOrderId; // Update with broker's order ID
    }
    this.transitionState(orderId, OrderState.ACKNOWLEDGED, 'Order acknowledged by broker');
  }

  /**
   * Mark order as rejected
   */
  public markOrderRejected(orderId: string, reason: string): void {
    const order = this.orders.get(orderId);
    if (order) {
      order.errorMessage = reason;
    }
    this.transitionState(orderId, OrderState.REJECTED, reason);
    this.clearPendingOrderTimeout(orderId);
  }

  /**
   * Mark order as failed
   */
  public markOrderFailed(orderId: string, error: string): void {
    const order = this.orders.get(orderId);
    if (order) {
      order.errorMessage = error;
    }
    this.transitionState(orderId, OrderState.FAILED, error);
    this.clearPendingOrderTimeout(orderId);
  }

  /**
   * Link stop-loss/target orders to parent entry order
   */
  public linkChildOrder(parentOrderId: string, childOrderId: string): void {
    const parentOrder = this.orders.get(parentOrderId);
    const childOrder = this.orders.get(childOrderId);

    if (parentOrder && childOrder) {
      if (!parentOrder.childOrderIds) {
        parentOrder.childOrderIds = [];
      }
      parentOrder.childOrderIds.push(childOrderId);
      childOrder.parentOrderId = parentOrderId;

      logger.info('🔗 Orders linked', {
        parent: parentOrderId,
        child: childOrderId
      });
    }
  }

  /**
   * Cancel all child orders when parent is filled/cancelled
   */
  public async cancelChildOrders(parentOrderId: string): Promise<void> {
    const parentOrder = this.orders.get(parentOrderId);
    if (!parentOrder || !parentOrder.childOrderIds) {
      return;
    }

    logger.info('🚫 Cancelling child orders', {
      parent: parentOrderId,
      children: parentOrder.childOrderIds
    });

    for (const childId of parentOrder.childOrderIds) {
      this.transitionState(childId, OrderState.CANCELLED, 'Parent order completed');
    }

    this.emit('child_orders_cancelled', {
      parentOrderId,
      childOrderIds: parentOrder.childOrderIds
    });
  }

  /**
   * Get order by ID
   */
  public getOrder(orderId: string): OrderStateRecord | undefined {
    return this.orders.get(orderId);
  }

  /**
   * Get all orders
   */
  public getAllOrders(): OrderStateRecord[] {
    return Array.from(this.orders.values());
  }

  /**
   * Get orders by state
   */
  public getOrdersByState(state: OrderState): OrderStateRecord[] {
    return Array.from(this.orders.values()).filter(o => o.state === state);
  }

  /**
   * Get pending orders (not in terminal state)
   */
  public getPendingOrders(): OrderStateRecord[] {
    return Array.from(this.orders.values()).filter(o => !this.isTerminalState(o.state));
  }

  /**
   * Get orders for a symbol
   */
  public getOrdersForSymbol(symbol: string): OrderStateRecord[] {
    return Array.from(this.orders.values()).filter(o => o.symbol === symbol);
  }

  /**
   * Check if order can be retried
   */
  public canRetry(orderId: string): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;

    return order.retryCount < this.MAX_RETRY_COUNT &&
           (order.state === OrderState.FAILED || order.state === OrderState.REJECTED);
  }

  /**
   * Increment retry count
   */
  public incrementRetryCount(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order) {
      order.retryCount++;
      logger.info('🔄 Order retry attempt', {
        orderId,
        retryCount: order.retryCount,
        maxRetries: this.MAX_RETRY_COUNT
      });
    }
  }

  /**
   * Transition order to new state
   */
  private transitionState(orderId: string, newState: OrderState, reason?: string): void {
    const order = this.orders.get(orderId);
    if (!order) {
      logger.warn('Cannot transition state for unknown order', { orderId });
      return;
    }

    const oldState = order.state;

    // Validate state transition
    if (!this.isValidTransition(oldState, newState)) {
      logger.warn('Invalid state transition attempted', {
        orderId,
        from: oldState,
        to: newState
      });
      return;
    }

    // Record transition
    const transition: OrderStateTransition = {
      fromState: oldState,
      toState: newState,
      timestamp: new Date(),
      reason
    };

    order.stateHistory.push(transition);
    order.state = newState;
    order.lastUpdatedAt = new Date();

    logger.info('🔄 Order state transition', {
      orderId,
      symbol: order.symbol,
      from: oldState,
      to: newState,
      reason
    });

    logger.audit('ORDER_STATE_TRANSITION', {
      orderId,
      transition
    });

    this.emit('state_changed', { orderId, oldState, newState, order });
  }

  /**
   * Validate if state transition is allowed
   */
  private isValidTransition(from: OrderState, to: OrderState): boolean {
    const validTransitions: Record<OrderState, OrderState[]> = {
      [OrderState.CREATED]: [OrderState.PENDING],
      [OrderState.PENDING]: [OrderState.SUBMITTED, OrderState.FAILED],
      [OrderState.SUBMITTED]: [OrderState.ACKNOWLEDGED, OrderState.REJECTED, OrderState.FAILED],
      [OrderState.ACKNOWLEDGED]: [OrderState.PARTIALLY_FILLED, OrderState.FILLED, OrderState.CANCELLED, OrderState.REJECTED],
      [OrderState.PARTIALLY_FILLED]: [OrderState.FILLED, OrderState.CANCELLED],
      [OrderState.FILLED]: [],
      [OrderState.REJECTED]: [],
      [OrderState.CANCELLED]: [],
      [OrderState.FAILED]: [OrderState.PENDING], // Allow retry
      [OrderState.EXPIRED]: []
    };

    return validTransitions[from]?.includes(to) || false;
  }

  /**
   * Map OrderStatus to OrderState
   */
  private mapStatusToState(status: OrderStatus, filledQuantity: number = 0, totalQuantity: number): OrderState {
    switch (status) {
      case OrderStatus.PENDING:
        return OrderState.PENDING;
      case OrderStatus.SUBMITTED:
        return OrderState.SUBMITTED;
      case OrderStatus.FILLED:
        return OrderState.FILLED;
      case OrderStatus.REJECTED:
        return OrderState.REJECTED;
      case OrderStatus.CANCELLED:
        return OrderState.CANCELLED;
      default:
        // Check for partial fill
        if (filledQuantity > 0 && filledQuantity < totalQuantity) {
          return OrderState.PARTIALLY_FILLED;
        }
        return OrderState.PENDING;
    }
  }

  /**
   * Check if state is terminal (no further transitions)
   */
  private isTerminalState(state: OrderState): boolean {
    return [
      OrderState.FILLED,
      OrderState.REJECTED,
      OrderState.CANCELLED,
      OrderState.EXPIRED
    ].includes(state);
  }

  /**
   * Set timeout for pending order
   */
  private setPendingOrderTimeout(orderId: string): void {
    const timeout = setTimeout(() => {
      const order = this.orders.get(orderId);
      if (order && !this.isTerminalState(order.state)) {
        logger.warn('⏰ Order timeout - no response from broker', { orderId });
        this.transitionState(orderId, OrderState.EXPIRED, 'Order timeout');
        this.emit('order_timeout', order);
      }
    }, this.ORDER_TIMEOUT_MS);

    this.pendingOrders.set(orderId, timeout);
  }

  /**
   * Clear pending order timeout
   */
  private clearPendingOrderTimeout(orderId: string): void {
    const timeout = this.pendingOrders.get(orderId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingOrders.delete(orderId);
    }
  }

  /**
   * Emit specific events based on order state
   */
  private emitStateEvents(order: OrderStateRecord): void {
    switch (order.state) {
      case OrderState.FILLED:
        this.emit('order_filled', order);
        break;
      case OrderState.PARTIALLY_FILLED:
        this.emit('order_partially_filled', order);
        break;
      case OrderState.REJECTED:
        this.emit('order_rejected', order);
        break;
      case OrderState.CANCELLED:
        this.emit('order_cancelled', order);
        break;
      case OrderState.FAILED:
        this.emit('order_failed', order);
        break;
    }
  }

  /**
   * Get statistics
   */
  public getStatistics() {
    const orders = Array.from(this.orders.values());

    return {
      total: orders.length,
      byState: {
        created: orders.filter(o => o.state === OrderState.CREATED).length,
        pending: orders.filter(o => o.state === OrderState.PENDING).length,
        submitted: orders.filter(o => o.state === OrderState.SUBMITTED).length,
        acknowledged: orders.filter(o => o.state === OrderState.ACKNOWLEDGED).length,
        partiallyFilled: orders.filter(o => o.state === OrderState.PARTIALLY_FILLED).length,
        filled: orders.filter(o => o.state === OrderState.FILLED).length,
        rejected: orders.filter(o => o.state === OrderState.REJECTED).length,
        cancelled: orders.filter(o => o.state === OrderState.CANCELLED).length,
        failed: orders.filter(o => o.state === OrderState.FAILED).length,
        expired: orders.filter(o => o.state === OrderState.EXPIRED).length
      },
      activePending: this.getPendingOrders().length
    };
  }

  /**
   * Clean up old completed orders (keep last N days)
   */
  public cleanupOldOrders(daysToKeep: number = 7): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    let removedCount = 0;
    for (const [orderId, order] of this.orders) {
      if (this.isTerminalState(order.state) && order.lastUpdatedAt < cutoffDate) {
        this.orders.delete(orderId);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.info('🧹 Cleaned up old orders', {
        removed: removedCount,
        remaining: this.orders.size
      });
    }
  }
}

// Export singleton instance
export const orderStateManager = new OrderStateManager();
