import { EventEmitter } from 'events';
import { StrategySignal, StrategyContext, MarketData, Position } from '../types';

export interface IStrategy extends EventEmitter {
  getName(): string;
  initialize(): Promise<void>;
  onMarketData(data: MarketData): void;
  onPositionUpdate(position: Position): void;
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

  public onPositionUpdate(position: Position): void {
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
}
