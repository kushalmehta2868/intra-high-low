import { EventEmitter } from 'events';
import { StrategySignal, StrategyContext, MarketData, Position } from '../types';

export interface IStrategy extends EventEmitter {
  getName(): string;
  initialize(): Promise<void>;
  onMarketData(data: MarketData): void;
  onPositionUpdate(position: Position): void;
  setContextPosition(symbol: string, position: Position): void;
  removeContextPosition(symbol: string): void;
  shutdown(): Promise<void>;

  on(event: 'signal', listener: (signal: StrategySignal) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export abstract class BaseStrategy extends EventEmitter implements IStrategy {
  protected name: string;
  protected context: StrategyContext;
  protected isActive: boolean = false;

  constructor(name: string, context: StrategyContext) {
    super();
    this.name = name;
    this.context = context;
  }

  public getName(): string {
    return this.name;
  }

  public async initialize(): Promise<void> {
    this.isActive = true;
  }

  public abstract onMarketData(data: MarketData): void;

  public onPositionUpdate(_position: Position): void {
  }

  public async shutdown(): Promise<void> {
    this.isActive = false;
  }

  protected emitSignal(signal: StrategySignal): void {
    if (this.isActive) {
      this.emit('signal', signal);
    }
  }

  protected emitError(error: Error): void {
    this.emit('error', error);
  }

  protected updateContext(context: Partial<StrategyContext>): void {
    this.context = { ...this.context, ...context };
  }

  /** Called by TradingEngine when a new position is opened for a symbol. */
  public setContextPosition(symbol: string, position: Position): void {
    this.context.positions.set(symbol, position);
  }

  /** Called by TradingEngine when a position is fully closed for a symbol. */
  public removeContextPosition(symbol: string): void {
    this.context.positions.delete(symbol);
  }
}
