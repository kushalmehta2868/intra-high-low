import { EventEmitter } from 'events';
import { RiskLimits, Position, Order, OrderSide } from '../types';
import { logger } from '../utils/logger';

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

export class RiskManager extends EventEmitter {
  private riskLimits: RiskLimits;
  private tradesExecutedToday: number = 0;
  private dailyPnL: number = 0;
  private startingBalance: number = 0;
  private currentBalance: number = 0;
  private lastResetDate: string = '';

  constructor(riskLimits: RiskLimits, startingBalance: number) {
    super();
    this.riskLimits = riskLimits;
    this.startingBalance = startingBalance;
    this.currentBalance = startingBalance;
    this.resetDailyCounters();
  }

  private resetDailyCounters(): void {
    const today = new Date().toISOString().split('T')[0];

    if (this.lastResetDate !== today) {
      this.tradesExecutedToday = 0;
      this.dailyPnL = 0;
      this.lastResetDate = today;

      logger.info('Daily risk counters reset', { date: today });
      logger.audit('RISK_COUNTERS_RESET', { date: today });
    }
  }

  public checkOrderRisk(
    symbol: string,
    side: OrderSide,
    quantity: number,
    price: number,
    stopLoss?: number
  ): RiskCheckResult {
    this.resetDailyCounters();

    if (this.tradesExecutedToday >= this.riskLimits.maxTradesPerDay) {
      const reason = `Max trades per day limit reached (${this.riskLimits.maxTradesPerDay})`;
      logger.warn('Risk check failed', { reason });
      return { allowed: false, reason };
    }

    const dailyLossLimit = (this.riskLimits.maxDailyLossPercent / 100) * this.startingBalance;
    if (this.dailyPnL < 0 && Math.abs(this.dailyPnL) >= dailyLossLimit) {
      const reason = `Max daily loss limit reached (${this.riskLimits.maxDailyLossPercent}%)`;
      logger.warn('Risk check failed', { reason, dailyPnL: this.dailyPnL, limit: dailyLossLimit });
      this.emit('daily_loss_limit_reached', { dailyPnL: this.dailyPnL, limit: dailyLossLimit });
      return { allowed: false, reason };
    }

    const orderValue = quantity * price;
    const effectiveBuyingPower = this.riskLimits.useMargin
      ? this.currentBalance * this.riskLimits.marginMultiplier
      : this.currentBalance;
    const maxPositionSize = (this.riskLimits.positionSizePercent / 100) * effectiveBuyingPower;

    if (orderValue > maxPositionSize) {
      const reason = `Position size exceeds limit (${this.riskLimits.positionSizePercent}% of ${this.riskLimits.useMargin ? 'margin-adjusted' : ''} balance)`;
      logger.warn('Risk check failed', { reason, orderValue, maxPositionSize, effectiveBuyingPower, marginEnabled: this.riskLimits.useMargin });
      return { allowed: false, reason };
    }

    if (stopLoss) {
      const riskPerShare = Math.abs(price - stopLoss);
      const totalRisk = riskPerShare * quantity;
      const maxRiskAllowed = (this.riskLimits.maxRiskPerTradePercent / 100) * this.currentBalance;

      if (totalRisk > maxRiskAllowed) {
        const reason = `Risk per trade exceeds limit (${this.riskLimits.maxRiskPerTradePercent}%)`;
        logger.warn('Risk check failed', { reason, totalRisk, maxRiskAllowed });
        return { allowed: false, reason };
      }
    }

    return { allowed: true };
  }

  public calculatePositionSize(
    entryPrice: number,
    stopLoss: number,
    maxRiskAmount?: number
  ): number {
    const riskAmount = maxRiskAmount ||
      (this.riskLimits.maxRiskPerTradePercent / 100) * this.currentBalance;

    const riskPerShare = Math.abs(entryPrice - stopLoss);

    if (riskPerShare === 0) {
      logger.warn('Cannot calculate position size: stop loss equals entry price');
      return 0;
    }

    const quantity = Math.floor(riskAmount / riskPerShare);

    const effectiveBuyingPower = this.riskLimits.useMargin
      ? this.currentBalance * this.riskLimits.marginMultiplier
      : this.currentBalance;
    const maxPositionValue = (this.riskLimits.positionSizePercent / 100) * effectiveBuyingPower;
    const maxQuantityByPosition = Math.floor(maxPositionValue / entryPrice);

    const finalQuantity = Math.min(quantity, maxQuantityByPosition);

    logger.debug('Position size calculated', {
      entryPrice,
      stopLoss,
      riskAmount,
      calculatedQuantity: quantity,
      effectiveBuyingPower,
      marginEnabled: this.riskLimits.useMargin,
      marginMultiplier: this.riskLimits.marginMultiplier,
      maxQuantityByPosition,
      finalQuantity
    });

    return finalQuantity;
  }

  public recordTrade(pnl: number): void {
    this.resetDailyCounters();
    this.tradesExecutedToday++;
    this.dailyPnL += pnl;

    logger.info('Trade recorded', {
      tradesExecutedToday: this.tradesExecutedToday,
      dailyPnL: this.dailyPnL,
      tradePnL: pnl
    });

    logger.audit('TRADE_RECORDED', {
      tradesExecutedToday: this.tradesExecutedToday,
      dailyPnL: this.dailyPnL,
      pnl
    });

    this.checkRiskThresholds();
  }

  public updateBalance(balance: number): void {
    this.currentBalance = balance;
  }

  private checkRiskThresholds(): void {
    const dailyLossLimit = (this.riskLimits.maxDailyLossPercent / 100) * this.startingBalance;
    const lossPercentage = (Math.abs(this.dailyPnL) / this.startingBalance) * 100;

    if (this.dailyPnL < 0) {
      if (Math.abs(this.dailyPnL) >= dailyLossLimit * 0.8) {
        logger.warn('Approaching daily loss limit', {
          dailyPnL: this.dailyPnL,
          limit: dailyLossLimit,
          percentage: lossPercentage
        });
        this.emit('approaching_daily_loss_limit', {
          dailyPnL: this.dailyPnL,
          limit: dailyLossLimit,
          percentage: lossPercentage
        });
      }
    }

    if (this.tradesExecutedToday >= this.riskLimits.maxTradesPerDay * 0.8) {
      logger.warn('Approaching max trades per day', {
        tradesExecutedToday: this.tradesExecutedToday,
        limit: this.riskLimits.maxTradesPerDay
      });
      this.emit('approaching_max_trades', {
        tradesExecutedToday: this.tradesExecutedToday,
        limit: this.riskLimits.maxTradesPerDay
      });
    }
  }

  public getRiskStats() {
    this.resetDailyCounters();

    const dailyLossLimit = (this.riskLimits.maxDailyLossPercent / 100) * this.startingBalance;
    const lossPercentage = this.dailyPnL < 0
      ? (Math.abs(this.dailyPnL) / this.startingBalance) * 100
      : 0;

    return {
      tradesExecutedToday: this.tradesExecutedToday,
      maxTradesPerDay: this.riskLimits.maxTradesPerDay,
      tradesRemaining: Math.max(0, this.riskLimits.maxTradesPerDay - this.tradesExecutedToday),
      dailyPnL: this.dailyPnL,
      dailyLossLimit: dailyLossLimit,
      dailyLossPercentage: lossPercentage,
      maxDailyLossPercent: this.riskLimits.maxDailyLossPercent,
      isAtRiskLimit: this.dailyPnL < 0 && Math.abs(this.dailyPnL) >= dailyLossLimit
    };
  }

  public updateRiskLimits(newLimits: Partial<RiskLimits>): void {
    this.riskLimits = { ...this.riskLimits, ...newLimits };
    logger.info('Risk limits updated', this.riskLimits);
    logger.audit('RISK_LIMITS_UPDATED', this.riskLimits);
  }

  public resetStartingBalance(balance: number): void {
    this.startingBalance = balance;
    this.currentBalance = balance;
    logger.info('Starting balance reset', { balance });
    logger.audit('STARTING_BALANCE_RESET', { balance });
  }
}
