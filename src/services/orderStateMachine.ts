import { EventEmitter } from 'events';
import { Order, OrderStatus } from '../types';
import { logger } from '../utils/logger';

export enum OrderEvent {
  SUBMIT = 'SUBMIT',
  ACCEPT = 'ACCEPT',
  PARTIAL_FILL = 'PARTIAL_FILL',
  FILL = 'FILL',
  CANCEL = 'CANCEL',
  REJECT = 'REJECT',
  EXPIRE = 'EXPIRE',
  TIMEOUT = 'TIMEOUT'
}

export interface OrderStateTransition {
  from: OrderStatus;
  to: OrderStatus;
  event: OrderEvent;
  timestamp: Date;
  metadata?: any;
}

export interface OrderStateMachineConfig {
  pendingTimeoutMs: number;      // Timeout for pending state
  submittedTimeoutMs: number;    // Timeout for submitted state
  autoRejectOnTimeout: boolean;  // Auto-reject if timeout
}

export class OrderStateMachine extends EventEmitter {
  private orderId: string;
  private currentState: OrderStatus;
  private stateHistory: OrderStateTransition[] = [];
  private config: OrderStateMachineConfig;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private createdAt: Date;
  private lastUpdated: Date;

  private static validTransitions: Map<OrderStatus, Map<OrderEvent, OrderStatus>> = new Map([
    [OrderStatus.PENDING, new Map([
      [OrderEvent.SUBMIT, OrderStatus.SUBMITTED],
      [OrderEvent.REJECT, OrderStatus.REJECTED],
      [OrderEvent.TIMEOUT, OrderStatus.REJECTED]
    ])],
    [OrderStatus.SUBMITTED, new Map([
      [OrderEvent.ACCEPT, OrderStatus.SUBMITTED],
      [OrderEvent.PARTIAL_FILL, OrderStatus.PARTIALLY_FILLED],
      [OrderEvent.FILL, OrderStatus.FILLED],
      [OrderEvent.CANCEL, OrderStatus.CANCELLED],
      [OrderEvent.REJECT, OrderStatus.REJECTED],
      [OrderEvent.TIMEOUT, OrderStatus.REJECTED]
    ])],
    [OrderStatus.PARTIALLY_FILLED, new Map([
      [OrderEvent.PARTIAL_FILL, OrderStatus.PARTIALLY_FILLED],
      [OrderEvent.FILL, OrderStatus.FILLED],
      [OrderEvent.CANCEL, OrderStatus.CANCELLED]
    ])],
    // Terminal states have no outgoing transitions
    [OrderStatus.FILLED, new Map()],
    [OrderStatus.CANCELLED, new Map()],
    [OrderStatus.REJECTED, new Map()]
  ]);

  private static defaultConfig: OrderStateMachineConfig = {
    pendingTimeoutMs: 10000,        // 10 seconds
    submittedTimeoutMs: 60000,      // 60 seconds
    autoRejectOnTimeout: true
  };

  constructor(orderId: string, initialState: OrderStatus = OrderStatus.PENDING, config?: Partial<OrderStateMachineConfig>) {
    super();
    this.orderId = orderId;
    this.currentState = initialState;
    this.config = { ...OrderStateMachine.defaultConfig, ...config };
    this.createdAt = new Date();
    this.lastUpdated = new Date();

    logger.debug('Order state machine created', {
      orderId: this.orderId,
      initialState: this.currentState
    });

    this.startTimeoutMonitoring();
  }

  /**
   * Transition to a new state based on an event
   */
  public transition(event: OrderEvent, metadata?: any): boolean {
    const validNextStates = OrderStateMachine.validTransitions.get(this.currentState);

    if (!validNextStates) {
      logger.error('No valid transitions from current state', {
        orderId: this.orderId,
        currentState: this.currentState,
        event: event
      });
      return false;
    }

    const nextState = validNextStates.get(event);

    if (!nextState) {
      logger.warn('Invalid state transition attempted', {
        orderId: this.orderId,
        currentState: this.currentState,
        event: event,
        validEvents: Array.from(validNextStates.keys())
      });

      this.emit('invalid_transition', {
        orderId: this.orderId,
        currentState: this.currentState,
        event: event
      });

      return false;
    }

    return this.setState(nextState, event, metadata);
  }

  /**
   * Force set state (use with caution)
   */
  private setState(newState: OrderStatus, event: OrderEvent, metadata?: any): boolean {
    const previousState = this.currentState;

    logger.info('Order state transition', {
      orderId: this.orderId,
      from: previousState,
      to: newState,
      event: event
    });

    this.currentState = newState;
    this.lastUpdated = new Date();

    // Record transition
    const transition: OrderStateTransition = {
      from: previousState,
      to: newState,
      event: event,
      timestamp: new Date(),
      metadata: metadata
    };

    this.stateHistory.push(transition);

    logger.audit('ORDER_STATE_TRANSITION', {
      orderId: this.orderId,
      transition: transition
    });

    // Emit events
    this.emit('state_changed', {
      orderId: this.orderId,
      previousState: previousState,
      newState: newState,
      event: event,
      metadata: metadata
    });

    this.emit(`state:${newState}`, {
      orderId: this.orderId,
      metadata: metadata
    });

    // Handle terminal states
    if (this.isTerminalState(newState)) {
      this.stopTimeoutMonitoring();
      this.emit('terminal_state', {
        orderId: this.orderId,
        finalState: newState
      });
    }

    return true;
  }

  /**
   * Check if state is terminal (no further transitions)
   */
  public isTerminalState(state?: OrderStatus): boolean {
    const checkState = state || this.currentState;
    return checkState === OrderStatus.FILLED ||
           checkState === OrderStatus.CANCELLED ||
           checkState === OrderStatus.REJECTED;
  }

  /**
   * Start timeout monitoring
   */
  private startTimeoutMonitoring(): void {
    if (this.currentState === OrderStatus.PENDING) {
      this.scheduleTimeout(this.config.pendingTimeoutMs);
    } else if (this.currentState === OrderStatus.SUBMITTED) {
      this.scheduleTimeout(this.config.submittedTimeoutMs);
    }
  }

  /**
   * Schedule timeout
   */
  private scheduleTimeout(delayMs: number): void {
    this.stopTimeoutMonitoring();

    this.timeoutTimer = setTimeout(() => {
      logger.warn('Order timeout', {
        orderId: this.orderId,
        state: this.currentState,
        ageMs: Date.now() - this.createdAt.getTime()
      });

      logger.audit('ORDER_TIMEOUT', {
        orderId: this.orderId,
        state: this.currentState,
        ageMs: Date.now() - this.createdAt.getTime()
      });

      this.emit('timeout', {
        orderId: this.orderId,
        state: this.currentState
      });

      if (this.config.autoRejectOnTimeout) {
        this.transition(OrderEvent.TIMEOUT, { reason: 'timeout' });
      }
    }, delayMs);
  }

  /**
   * Stop timeout monitoring
   */
  private stopTimeoutMonitoring(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  /**
   * Get current state
   */
  public getState(): OrderStatus {
    return this.currentState;
  }

  /**
   * Get state history
   */
  public getHistory(): OrderStateTransition[] {
    return [...this.stateHistory];
  }

  /**
   * Get order age in milliseconds
   */
  public getAgeMs(): number {
    return Date.now() - this.createdAt.getTime();
  }

  /**
   * Get time since last update in milliseconds
   */
  public getTimeSinceLastUpdateMs(): number {
    return Date.now() - this.lastUpdated.getTime();
  }

  /**
   * Check if order can be cancelled
   */
  public canCancel(): boolean {
    const validStates = OrderStateMachine.validTransitions.get(this.currentState);
    return validStates?.has(OrderEvent.CANCEL) || false;
  }

  /**
   * Get statistics
   */
  public getStats() {
    return {
      orderId: this.orderId,
      currentState: this.currentState,
      isTerminal: this.isTerminalState(),
      createdAt: this.createdAt,
      lastUpdated: this.lastUpdated,
      ageMs: this.getAgeMs(),
      timeSinceLastUpdateMs: this.getTimeSinceLastUpdateMs(),
      transitionCount: this.stateHistory.length,
      canCancel: this.canCancel()
    };
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.stopTimeoutMonitoring();
    this.removeAllListeners();
  }
}

/**
 * Manages multiple order state machines
 */
export class OrderStateMachineManager extends EventEmitter {
  private machines: Map<string, OrderStateMachine> = new Map();
  private config: Partial<OrderStateMachineConfig>;

  constructor(config?: Partial<OrderStateMachineConfig>) {
    super();
    this.config = config || {};
  }

  /**
   * Create or get state machine for an order
   */
  public getOrCreate(orderId: string, initialState: OrderStatus = OrderStatus.PENDING): OrderStateMachine {
    if (!this.machines.has(orderId)) {
      const machine = new OrderStateMachine(orderId, initialState, this.config);

      // Forward events
      machine.on('state_changed', (data) => {
        this.emit('order_state_changed', data);
      });

      machine.on('terminal_state', (data) => {
        this.emit('order_terminal_state', data);
        // Auto-cleanup after some time in terminal state
        setTimeout(() => this.remove(orderId), 300000); // 5 minutes
      });

      machine.on('timeout', (data) => {
        this.emit('order_timeout', data);
      });

      machine.on('invalid_transition', (data) => {
        this.emit('order_invalid_transition', data);
      });

      this.machines.set(orderId, machine);

      logger.debug('Order state machine created', { orderId });
    }

    return this.machines.get(orderId)!;
  }

  /**
   * Get existing machine
   */
  public get(orderId: string): OrderStateMachine | undefined {
    return this.machines.get(orderId);
  }

  /**
   * Remove machine
   */
  public remove(orderId: string): boolean {
    const machine = this.machines.get(orderId);
    if (machine) {
      machine.destroy();
      this.machines.delete(orderId);
      logger.debug('Order state machine removed', { orderId });
      return true;
    }
    return false;
  }

  /**
   * Update order state
   */
  public updateOrderState(order: Order): boolean {
    const machine = this.getOrCreate(order.orderId, order.status);

    // Determine event based on status change
    let event: OrderEvent | null = null;

    switch (order.status) {
      case OrderStatus.SUBMITTED:
        event = machine.getState() === OrderStatus.PENDING ? OrderEvent.SUBMIT : OrderEvent.ACCEPT;
        break;
      case OrderStatus.PARTIALLY_FILLED:
        event = OrderEvent.PARTIAL_FILL;
        break;
      case OrderStatus.FILLED:
        event = OrderEvent.FILL;
        break;
      case OrderStatus.CANCELLED:
        event = OrderEvent.CANCEL;
        break;
      case OrderStatus.REJECTED:
        event = OrderEvent.REJECT;
        break;
    }

    if (event && machine.getState() !== order.status) {
      return machine.transition(event, {
        filledQuantity: order.filledQuantity,
        averagePrice: order.averagePrice,
        timestamp: order.timestamp
      });
    }

    return false;
  }

  /**
   * Get all machines
   */
  public getAll(): OrderStateMachine[] {
    return Array.from(this.machines.values());
  }

  /**
   * Get machines by state
   */
  public getByState(state: OrderStatus): OrderStateMachine[] {
    return this.getAll().filter(m => m.getState() === state);
  }

  /**
   * Get non-terminal orders
   */
  public getActiveOrders(): OrderStateMachine[] {
    return this.getAll().filter(m => !m.isTerminalState());
  }

  /**
   * Get statistics
   */
  public getStats() {
    const all = this.getAll();

    return {
      totalOrders: all.length,
      activeOrders: this.getActiveOrders().length,
      byState: {
        pending: this.getByState(OrderStatus.PENDING).length,
        submitted: this.getByState(OrderStatus.SUBMITTED).length,
        partiallyFilled: this.getByState(OrderStatus.PARTIALLY_FILLED).length,
        filled: this.getByState(OrderStatus.FILLED).length,
        cancelled: this.getByState(OrderStatus.CANCELLED).length,
        rejected: this.getByState(OrderStatus.REJECTED).length
      }
    };
  }

  /**
   * Cleanup all machines
   */
  public cleanup(): void {
    for (const machine of this.machines.values()) {
      machine.destroy();
    }
    this.machines.clear();
  }
}
