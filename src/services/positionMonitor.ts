import { EventEmitter } from 'events';
import { PositionManager } from '../core/positionManager';
import { IBroker } from '../brokers/base';
import { Position, PositionType } from '../types';
import { logger } from '../utils/logger';

interface PositionAlert {
  symbol: string;
  type: 'stop_loss' | 'target' | 'trailing_stop' | 'time_based' | 'risk_limit';
  message: string;
  position: Position;
}

interface TrailingStopConfig {
  symbol: string;
  activationPercent: number; // Profit % to activate trailing stop
  trailPercent: number; // % to trail from high/low
  highWaterMark: number; // Highest price seen (for long) or lowest (for short)
  isActive: boolean;
}

export class PositionMonitorService extends EventEmitter {
  private positionManager: PositionManager;
  private broker: IBroker;
  private monitorInterval: NodeJS.Timeout | null = null;
  private checkIntervalMs: number = 1000; // 1 second
  private isRunning: boolean = false;
  private trailingStops: Map<string, TrailingStopConfig> = new Map();

  // Risk monitoring
  private maxPositionHoldTimeMs: number = 4 * 60 * 60 * 1000; // 4 hours
  private maxUnrealizedLossPercent: number = 5; // 5% max loss per position

  constructor(positionManager: PositionManager, broker: IBroker) {
    super();
    this.positionManager = positionManager;
    this.broker = broker;
  }

  public start(): void {
    if (this.isRunning) {
      logger.warn('Position monitor already running');
      return;
    }

    this.isRunning = true;
    this.monitorInterval = setInterval(
      () => this.monitorPositions(),
      this.checkIntervalMs
    );

    logger.info('Position monitor service started', {
      intervalMs: this.checkIntervalMs,
      maxHoldTimeMs: this.maxPositionHoldTimeMs,
      maxLossPercent: this.maxUnrealizedLossPercent
    });

    logger.audit('POSITION_MONITOR_STARTED', {});
  }

  public stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    this.isRunning = false;

    logger.info('Position monitor service stopped');
    logger.audit('POSITION_MONITOR_STOPPED', {});
  }

  private async monitorPositions(): Promise<void> {
    try {
      // Update all position prices
      await this.positionManager.updateMarketPrices();

      const positions = this.positionManager.getAllPositions();

      for (const position of positions) {
        // Check static stop loss
        if (position.stopLoss && this.shouldTriggerStopLoss(position)) {
          this.emitAlert({
            symbol: position.symbol,
            type: 'stop_loss',
            message: `Stop loss triggered at ${position.currentPrice.toFixed(2)}`,
            position: position
          });
        }

        // Check target
        if (position.target && this.shouldTriggerTarget(position)) {
          this.emitAlert({
            symbol: position.symbol,
            type: 'target',
            message: `Target reached at ${position.currentPrice.toFixed(2)}`,
            position: position
          });
        }

        // Check trailing stop
        this.checkTrailingStop(position);

        // Check time-based exit
        this.checkTimeBasedExit(position);

        // Check risk limits
        this.checkRiskLimits(position);
      }
    } catch (error: any) {
      logger.error('Error monitoring positions', error);
      this.emit('monitor_error', error);
    }
  }

  private shouldTriggerStopLoss(position: Position): boolean {
    if (!position.stopLoss) return false;

    if (position.type === PositionType.LONG) {
      return position.currentPrice <= position.stopLoss;
    } else {
      return position.currentPrice >= position.stopLoss;
    }
  }

  private shouldTriggerTarget(position: Position): boolean {
    if (!position.target) return false;

    if (position.type === PositionType.LONG) {
      return position.currentPrice >= position.target;
    } else {
      return position.currentPrice <= position.target;
    }
  }

  public enableTrailingStop(
    symbol: string,
    activationPercent: number = 2,
    trailPercent: number = 1
  ): void {
    const position = this.positionManager.getPosition(symbol);
    if (!position) {
      logger.warn('Cannot enable trailing stop: position not found', { symbol });
      return;
    }

    this.trailingStops.set(symbol, {
      symbol: symbol,
      activationPercent: activationPercent,
      trailPercent: trailPercent,
      highWaterMark: position.currentPrice,
      isActive: false
    });

    logger.info('Trailing stop enabled', {
      symbol,
      activationPercent,
      trailPercent
    });

    logger.audit('TRAILING_STOP_ENABLED', {
      symbol,
      activationPercent,
      trailPercent
    });
  }

  private checkTrailingStop(position: Position): void {
    const trailingConfig = this.trailingStops.get(position.symbol);
    if (!trailingConfig) return;

    const profitPercent = position.pnlPercent;

    // Activate trailing stop if profit reaches activation threshold
    if (!trailingConfig.isActive && profitPercent >= trailingConfig.activationPercent) {
      trailingConfig.isActive = true;
      trailingConfig.highWaterMark = position.currentPrice;

      logger.info('Trailing stop activated', {
        symbol: position.symbol,
        profitPercent: profitPercent.toFixed(2),
        currentPrice: position.currentPrice
      });

      logger.audit('TRAILING_STOP_ACTIVATED', {
        symbol: position.symbol,
        profitPercent,
        currentPrice: position.currentPrice
      });
    }

    if (trailingConfig.isActive) {
      // Update high water mark
      if (position.type === PositionType.LONG) {
        if (position.currentPrice > trailingConfig.highWaterMark) {
          trailingConfig.highWaterMark = position.currentPrice;
        }

        // Check if price fell below trailing stop
        const trailAmount = trailingConfig.highWaterMark * (trailingConfig.trailPercent / 100);
        const stopPrice = trailingConfig.highWaterMark - trailAmount;

        if (position.currentPrice <= stopPrice) {
          this.emitAlert({
            symbol: position.symbol,
            type: 'trailing_stop',
            message: `Trailing stop triggered at ${position.currentPrice.toFixed(2)} (Trail from ${trailingConfig.highWaterMark.toFixed(2)})`,
            position: position
          });

          this.trailingStops.delete(position.symbol);
        }
      } else {
        // SHORT position
        if (position.currentPrice < trailingConfig.highWaterMark) {
          trailingConfig.highWaterMark = position.currentPrice;
        }

        // Check if price rose above trailing stop
        const trailAmount = trailingConfig.highWaterMark * (trailingConfig.trailPercent / 100);
        const stopPrice = trailingConfig.highWaterMark + trailAmount;

        if (position.currentPrice >= stopPrice) {
          this.emitAlert({
            symbol: position.symbol,
            type: 'trailing_stop',
            message: `Trailing stop triggered at ${position.currentPrice.toFixed(2)} (Trail from ${trailingConfig.highWaterMark.toFixed(2)})`,
            position: position
          });

          this.trailingStops.delete(position.symbol);
        }
      }
    }
  }

  private checkTimeBasedExit(position: Position): void {
    const holdTime = Date.now() - position.entryTime.getTime();

    if (holdTime > this.maxPositionHoldTimeMs) {
      this.emitAlert({
        symbol: position.symbol,
        type: 'time_based',
        message: `Position held for ${(holdTime / (60 * 60 * 1000)).toFixed(2)} hours - consider closing`,
        position: position
      });
    }
  }

  private checkRiskLimits(position: Position): void {
    if (position.pnlPercent < -this.maxUnrealizedLossPercent) {
      this.emitAlert({
        symbol: position.symbol,
        type: 'risk_limit',
        message: `Unrealized loss exceeds ${this.maxUnrealizedLossPercent}% (Current: ${position.pnlPercent.toFixed(2)}%)`,
        position: position
      });
    }
  }

  private emitAlert(alert: PositionAlert): void {
    logger.warn('Position alert', {
      symbol: alert.symbol,
      type: alert.type,
      message: alert.message,
      pnl: alert.position.pnl,
      pnlPercent: alert.position.pnlPercent
    });

    logger.audit('POSITION_ALERT', {
      symbol: alert.symbol,
      type: alert.type,
      currentPrice: alert.position.currentPrice,
      pnl: alert.position.pnl,
      pnlPercent: alert.position.pnlPercent
    });

    this.emit('position_alert', alert);
    this.emit(`alert:${alert.type}`, alert);
  }

  public async syncPositionsWithBroker(): Promise<void> {
    try {
      logger.info('Syncing positions with broker');
      await this.positionManager.syncPositions();

      logger.audit('POSITIONS_SYNCED_WITH_BROKER', {
        positionCount: this.positionManager.getAllPositions().length
      });
    } catch (error: any) {
      logger.error('Error syncing positions with broker', error);
      throw error;
    }
  }

  public getMonitoredPositions(): Position[] {
    return this.positionManager.getAllPositions();
  }

  public getTrailingStopConfig(symbol: string): TrailingStopConfig | undefined {
    return this.trailingStops.get(symbol);
  }

  public removeTrailingStop(symbol: string): void {
    if (this.trailingStops.has(symbol)) {
      this.trailingStops.delete(symbol);
      logger.info('Trailing stop removed', { symbol });
    }
  }

  public setMaxPositionHoldTime(milliseconds: number): void {
    this.maxPositionHoldTimeMs = milliseconds;
    logger.info('Max position hold time updated', { milliseconds });
  }

  public setMaxUnrealizedLossPercent(percent: number): void {
    this.maxUnrealizedLossPercent = percent;
    logger.info('Max unrealized loss percent updated', { percent });
  }
}
