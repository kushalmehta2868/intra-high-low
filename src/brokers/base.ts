import { EventEmitter } from 'events';
import { Order, Trade, Position, MarketData, OrderSide, OrderType } from '../types';

export interface IBroker extends EventEmitter {
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;

  placeOrder(
    symbol: string,
    side: OrderSide,
    type: OrderType,
    quantity: number,
    price?: number,
    stopPrice?: number,
    target?: number
  ): Promise<Order | null>;

  cancelOrder(orderId: string): Promise<boolean>;
  getOrders(): Promise<Order[]>;
  getPositions(): Promise<Position[]>;
  getAccountBalance(): Promise<number>;
  getLTP(symbol: string): Promise<number | null>;

  on(event: 'order_update', listener: (order: Order) => void): this;
  on(event: 'trade', listener: (trade: Trade) => void): this;
  on(event: 'position_update', listener: (position: Position) => void): this;
  on(event: 'market_data', listener: (data: MarketData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export abstract class BaseBroker extends EventEmitter implements IBroker {
  protected isConnected: boolean = false;

  abstract connect(): Promise<boolean>;
  abstract disconnect(): Promise<void>;

  abstract placeOrder(
    symbol: string,
    side: OrderSide,
    type: OrderType,
    quantity: number,
    price?: number,
    stopPrice?: number,
    target?: number
  ): Promise<Order | null>;

  abstract cancelOrder(orderId: string): Promise<boolean>;
  abstract getOrders(): Promise<Order[]>;
  abstract getPositions(): Promise<Position[]>;
  abstract getAccountBalance(): Promise<number>;
  abstract getLTP(symbol: string): Promise<number | null>;

  public isConnectedToBroker(): boolean {
    return this.isConnected;
  }

  protected emitOrderUpdate(order: Order): void {
    this.emit('order_update', order);
  }

  protected emitTrade(trade: Trade): void {
    this.emit('trade', trade);
  }

  protected emitPositionUpdate(position: Position): void {
    this.emit('position_update', position);
  }

  protected emitMarketData(data: MarketData): void {
    this.emit('market_data', data);
  }

  protected emitError(error: Error): void {
    this.emit('error', error);
  }
}
