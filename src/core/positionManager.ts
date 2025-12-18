import { EventEmitter } from 'events';
import { Position, Order, Trade, OrderSide, PositionType } from '../types';
import { IBroker } from '../brokers/base';
import { logger } from '../utils/logger';

export class PositionManager extends EventEmitter {
  private positions: Map<string, Position> = new Map();
  private broker: IBroker;

  constructor(broker: IBroker) {
    super();
    this.broker = broker;
    this.setupBrokerListeners();
  }

  private setupBrokerListeners(): void {
    this.broker.on('trade', (trade: Trade) => {
      this.handleTrade(trade);
    });

    this.broker.on('position_update', (position: Position) => {
      this.updatePosition(position);
    });
  }

  private handleTrade(trade: Trade): void {
    logger.info('Processing trade', {
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      price: trade.price
    });

    const existingPosition = this.positions.get(trade.symbol);

    if (!existingPosition) {
      const newPosition: Position = {
        symbol: trade.symbol,
        type: trade.side === OrderSide.BUY ? PositionType.LONG : PositionType.SHORT,
        quantity: trade.quantity,
        entryPrice: trade.price,
        currentPrice: trade.price,
        pnl: 0,
        pnlPercent: 0,
        entryTime: trade.timestamp
      };

      this.positions.set(trade.symbol, newPosition);
      this.emit('position_opened', newPosition);

      logger.info('New position opened', newPosition);
      logger.audit('POSITION_OPENED', newPosition);
    } else {
      this.updatePositionFromTrade(existingPosition, trade);
    }
  }

  private updatePositionFromTrade(position: Position, trade: Trade): void {
    const isClosingTrade = (position.type === PositionType.LONG && trade.side === OrderSide.SELL) ||
                           (position.type === PositionType.SHORT && trade.side === OrderSide.BUY);

    if (isClosingTrade) {
      const closedQuantity = Math.min(position.quantity, trade.quantity);
      const pnl = position.type === PositionType.LONG
        ? (trade.price - position.entryPrice) * closedQuantity
        : (position.entryPrice - trade.price) * closedQuantity;

      position.quantity -= closedQuantity;
      position.pnl = pnl;

      if (position.quantity === 0) {
        this.positions.delete(trade.symbol);
        this.emit('position_closed', { ...position, pnl });

        logger.info('Position closed', {
          symbol: trade.symbol,
          pnl,
          pnlPercent: (pnl / (position.entryPrice * closedQuantity)) * 100
        });

        logger.audit('POSITION_CLOSED', {
          symbol: trade.symbol,
          entryPrice: position.entryPrice,
          exitPrice: trade.price,
          quantity: closedQuantity,
          pnl
        });
      } else {
        this.emit('position_reduced', position);
        logger.info('Position reduced', {
          symbol: trade.symbol,
          remainingQuantity: position.quantity
        });
      }
    } else {
      const totalQuantity = position.quantity + trade.quantity;
      const avgPrice = ((position.entryPrice * position.quantity) +
                       (trade.price * trade.quantity)) / totalQuantity;

      position.quantity = totalQuantity;
      position.entryPrice = avgPrice;
      this.emit('position_increased', position);

      logger.info('Position increased', {
        symbol: trade.symbol,
        newQuantity: totalQuantity,
        avgPrice
      });
    }
  }

  private updatePosition(position: Position): void {
    this.positions.set(position.symbol, position);
    this.emit('position_updated', position);
  }

  public getPosition(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  public getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  public hasPosition(symbol: string): boolean {
    return this.positions.has(symbol);
  }

  public async syncPositions(): Promise<void> {
    try {
      const brokerPositions = await this.broker.getPositions();

      this.positions.clear();

      for (const position of brokerPositions) {
        this.positions.set(position.symbol, position);
      }

      logger.info('Positions synced with broker', {
        positionCount: this.positions.size
      });

      this.emit('positions_synced', brokerPositions);
    } catch (error: any) {
      logger.error('Failed to sync positions', error);
      this.emit('sync_error', error);
    }
  }

  public async updateMarketPrices(): Promise<void> {
    for (const position of this.positions.values()) {
      try {
        const ltp = await this.broker.getLTP(position.symbol);

        if (ltp !== null) {
          position.currentPrice = ltp;

          if (position.type === PositionType.LONG) {
            position.pnl = (ltp - position.entryPrice) * position.quantity;
          } else {
            position.pnl = (position.entryPrice - ltp) * position.quantity;
          }

          position.pnlPercent = (position.pnl / (position.entryPrice * position.quantity)) * 100;

          this.emit('position_updated', position);

          if (position.stopLoss && this.shouldTriggerStopLoss(position, ltp)) {
            this.emit('stop_loss_triggered', position);
            logger.warn('Stop loss triggered', {
              symbol: position.symbol,
              currentPrice: ltp,
              stopLoss: position.stopLoss
            });
          }

          if (position.target && this.shouldTriggerTarget(position, ltp)) {
            this.emit('target_reached', position);
            logger.info('Target reached', {
              symbol: position.symbol,
              currentPrice: ltp,
              target: position.target
            });
          }
        }
      } catch (error: any) {
        logger.error(`Failed to update price for ${position.symbol}`, error);
      }
    }
  }

  private shouldTriggerStopLoss(position: Position, currentPrice: number): boolean {
    if (!position.stopLoss) return false;

    if (position.type === PositionType.LONG) {
      return currentPrice <= position.stopLoss;
    } else {
      return currentPrice >= position.stopLoss;
    }
  }

  private shouldTriggerTarget(position: Position, currentPrice: number): boolean {
    if (!position.target) return false;

    if (position.type === PositionType.LONG) {
      return currentPrice >= position.target;
    } else {
      return currentPrice <= position.target;
    }
  }

  public getTotalPnL(): number {
    let totalPnL = 0;
    for (const position of this.positions.values()) {
      totalPnL += position.pnl;
    }
    return totalPnL;
  }

  public getPositionStats() {
    const positions = Array.from(this.positions.values());
    const totalPnL = this.getTotalPnL();

    const longPositions = positions.filter(p => p.type === PositionType.LONG);
    const shortPositions = positions.filter(p => p.type === PositionType.SHORT);

    const profitablePositions = positions.filter(p => p.pnl > 0);
    const losingPositions = positions.filter(p => p.pnl < 0);

    return {
      totalPositions: positions.length,
      longPositions: longPositions.length,
      shortPositions: shortPositions.length,
      totalPnL: totalPnL,
      profitablePositions: profitablePositions.length,
      losingPositions: losingPositions.length,
      avgPnLPerPosition: positions.length > 0 ? totalPnL / positions.length : 0
    };
  }
}
