import { EventEmitter } from 'events';
import { RiskLimits, Position, Order, OrderSide } from '../types';
import { logger } from '../utils/logger';
import { chargesCalculator } from '../services/chargesCalculator';

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface TradeRecord {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  grossPnL: number;
  netPnL: number;
  charges: number;
  pnlPercent: number;
  entryTime: Date;
  exitTime: Date;
  result: 'WIN' | 'LOSS' | 'BREAKEVEN';
}

export class RiskManager extends EventEmitter {
  private riskLimits: RiskLimits;
  private tradesExecutedToday: number = 0;
  private dailyPnL: number = 0; // This is now Net PnL
  private startingBalance: number = 0;
  private currentBalance: number = 0;
  private lastResetDate: string = '';
  private dailyTrades: TradeRecord[] = [];

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
      this.dailyTrades = [];
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
    stopLoss?: number,
    currentOpenPositions: number = 0 // New parameter for max positions check
  ): RiskCheckResult {
    this.resetDailyCounters();

    // 1. Check Max Open Positions (New Block)
    // Hard limit of 5 concurrent positions for risk diversification
    const MAX_OPEN_POSITIONS = 5;
    if (currentOpenPositions >= MAX_OPEN_POSITIONS) {
      const reason = `Max open positions limit reached (${MAX_OPEN_POSITIONS})`;
      logger.warn('Risk check failed', { reason, currentOpenPositions });
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

  public recordTrade(grossPnL: number, tradeDetails?: Partial<TradeRecord>): void {
    this.resetDailyCounters();
    this.tradesExecutedToday++;

    // Calculate charges if details available
    let charges = 0;
    if (tradeDetails && tradeDetails.quantity && tradeDetails.entryPrice && tradeDetails.exitPrice) {
      // Entry charges (Buy side usually)
      const entryValue = tradeDetails.quantity * tradeDetails.entryPrice;
      const entrySide = tradeDetails.side === 'BUY' ? OrderSide.BUY : OrderSide.SELL;
      const entryCharges = chargesCalculator.calculateTotalCharges(entryValue, entrySide);

      // Exit charges (Opposite side)
      const exitValue = tradeDetails.quantity * tradeDetails.exitPrice;
      const exitSide = tradeDetails.side === 'BUY' ? OrderSide.SELL : OrderSide.BUY;
      const exitCharges = chargesCalculator.calculateTotalCharges(exitValue, exitSide);

      charges = entryCharges.total + exitCharges.total;
    }

    const netPnL = grossPnL - charges;
    this.dailyPnL += netPnL;

    // Record detailed trade information if provided
    if (tradeDetails) {
      const trade: TradeRecord = {
        symbol: tradeDetails.symbol || 'UNKNOWN',
        side: tradeDetails.side || 'BUY',
        quantity: tradeDetails.quantity || 0,
        entryPrice: tradeDetails.entryPrice || 0,
        exitPrice: tradeDetails.exitPrice || 0,
        grossPnL: grossPnL,
        netPnL: netPnL,
        charges: charges,
        pnlPercent: tradeDetails.pnlPercent || 0,
        entryTime: tradeDetails.entryTime || new Date(),
        exitTime: tradeDetails.exitTime || new Date(),
        result: netPnL > 0 ? 'WIN' : 'LOSS' // Strict, slightly positive is win, even 0 is break-even but simplified
      };

      if (Math.abs(netPnL) < 1) trade.result = 'BREAKEVEN'; // Tolerance

      this.dailyTrades.push(trade);
    }


    logger.info('Trade recorded', {
      tradesExecutedToday: this.tradesExecutedToday,
      dailyPnL: this.dailyPnL,
      tradePnL: netPnL,
      grossPnL: grossPnL,
      charges: charges
    });

    logger.audit('TRADE_RECORDED', {
      tradesExecutedToday: this.tradesExecutedToday,
      dailyPnL: this.dailyPnL,
      netPnL,
      grossPnL
    });

    this.checkRiskThresholds();
  }

  public getDailyTrades(): TradeRecord[] {
    this.resetDailyCounters();
    return [...this.dailyTrades];
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
  }

  public getRiskStats() {
    this.resetDailyCounters();

    const dailyLossLimit = (this.riskLimits.maxDailyLossPercent / 100) * this.startingBalance;
    const lossPercentage = this.dailyPnL < 0
      ? (Math.abs(this.dailyPnL) / this.startingBalance) * 100
      : 0;

    return {
      tradesExecutedToday: this.tradesExecutedToday,
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
