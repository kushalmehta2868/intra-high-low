import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface TradeRecord {
  tradeId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  entryTime: Date;
  exitTime: Date;
  holdingPeriodMs: number;
  reason: string;
}

interface PerformanceMetrics {
  // Trade Statistics
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;
  winRate: number;

  // P&L Metrics
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  profitFactor: number;
  averageWin: number;
  averageLoss: number;
  averageTrade: number;
  largestWin: number;
  largestLoss: number;

  // Risk Metrics
  maxDrawdown: number;
  maxDrawdownPercent: number;
  currentDrawdown: number;
  sharpeRatio: number;
  sortinoRatio: number;

  // Streak Metrics
  currentStreak: number;
  longestWinStreak: number;
  longestLossStreak: number;

  // Time Metrics
  averageHoldingTimeMs: number;
  totalTradingDays: number;

  // Expectancy
  expectancy: number;
  expectancyPercent: number;
}

/**
 * Performance Tracker - Tracks all trades and calculates comprehensive performance metrics
 */
export class PerformanceTracker extends EventEmitter {
  private trades: TradeRecord[] = [];
  private equityCurve: number[] = [];
  private startingBalance: number = 0;
  private currentBalance: number = 0;
  private peakBalance: number = 0;
  private currentStreak: number = 0;
  private longestWinStreak: number = 0;
  private longestLossStreak: number = 0;

  constructor(startingBalance: number) {
    super();
    this.startingBalance = startingBalance;
    this.currentBalance = startingBalance;
    this.peakBalance = startingBalance;
    this.equityCurve.push(startingBalance);
  }

  /**
   * Record a completed trade
   */
  public recordTrade(trade: Omit<TradeRecord, 'tradeId' | 'holdingPeriodMs' | 'pnl' | 'pnlPercent'>): void {
    const holdingPeriodMs = trade.exitTime.getTime() - trade.entryTime.getTime();
    const pnl = trade.side === 'BUY'
      ? (trade.exitPrice - trade.entryPrice) * trade.quantity
      : (trade.entryPrice - trade.exitPrice) * trade.quantity;
    const pnlPercent = (pnl / (trade.entryPrice * trade.quantity)) * 100;

    const tradeRecord: TradeRecord = {
      tradeId: `TRADE-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ...trade,
      holdingPeriodMs,
      pnl,
      pnlPercent
    };

    this.trades.push(tradeRecord);
    this.currentBalance += pnl;
    this.equityCurve.push(this.currentBalance);

    // Update peak balance for drawdown calculation
    if (this.currentBalance > this.peakBalance) {
      this.peakBalance = this.currentBalance;
    }

    // Update streak tracking
    if (pnl > 0) {
      this.currentStreak = this.currentStreak >= 0 ? this.currentStreak + 1 : 1;
      this.longestWinStreak = Math.max(this.longestWinStreak, this.currentStreak);
    } else if (pnl < 0) {
      this.currentStreak = this.currentStreak <= 0 ? this.currentStreak - 1 : -1;
      this.longestLossStreak = Math.max(this.longestLossStreak, Math.abs(this.currentStreak));
    }

    logger.info('📊 Trade recorded', {
      symbol: trade.symbol,
      pnl: `₹${pnl.toFixed(2)}`,
      pnlPercent: `${pnlPercent.toFixed(2)}%`,
      totalTrades: this.trades.length,
      currentBalance: `₹${this.currentBalance.toFixed(2)}`
    });

    logger.audit('TRADE_RECORDED', tradeRecord);

    this.emit('trade_recorded', tradeRecord);
  }

  /**
   * Calculate comprehensive performance metrics
   */
  public getMetrics(): PerformanceMetrics {
    if (this.trades.length === 0) {
      return this.getEmptyMetrics();
    }

    const winningTrades = this.trades.filter(t => t.pnl > 0);
    const losingTrades = this.trades.filter(t => t.pnl < 0);
    const breakEvenTrades = this.trades.filter(t => t.pnl === 0);

    const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
    const netProfit = this.currentBalance - this.startingBalance;

    const averageWin = winningTrades.length > 0 ? grossProfit / winningTrades.length : 0;
    const averageLoss = losingTrades.length > 0 ? grossLoss / losingTrades.length : 0;
    const averageTrade = netProfit / this.trades.length;

    const largestWin = winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.pnl)) : 0;
    const largestLoss = losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.pnl)) : 0;

    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
    const winRate = (winningTrades.length / this.trades.length) * 100;

    // Drawdown calculation
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    let peak = this.startingBalance;

    for (const balance of this.equityCurve) {
      if (balance > peak) {
        peak = balance;
      }
      const drawdown = peak - balance;
      const drawdownPercent = (drawdown / peak) * 100;

      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownPercent = drawdownPercent;
      }
    }

    const currentDrawdown = this.peakBalance - this.currentBalance;

    // Sharpe and Sortino ratios
    const returns = this.trades.map(t => t.pnlPercent);
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0; // Annualized

    const negativeReturns = returns.filter(r => r < 0);
    const downsideVariance = negativeReturns.length > 0
      ? negativeReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / negativeReturns.length
      : 0;
    const downsideDeviation = Math.sqrt(downsideVariance);
    const sortinoRatio = downsideDeviation > 0 ? (avgReturn / downsideDeviation) * Math.sqrt(252) : 0;

    // Expectancy
    const expectancy = (winRate / 100) * averageWin - ((100 - winRate) / 100) * averageLoss;
    const expectancyPercent = (expectancy / this.startingBalance) * 100;

    // Average holding time
    const averageHoldingTimeMs = this.trades.reduce((sum, t) => sum + t.holdingPeriodMs, 0) / this.trades.length;

    // Unique trading days
    const uniqueDays = new Set(this.trades.map(t => t.entryTime.toISOString().split('T')[0]));
    const totalTradingDays = uniqueDays.size;

    return {
      totalTrades: this.trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      breakEvenTrades: breakEvenTrades.length,
      winRate,

      grossProfit,
      grossLoss,
      netProfit,
      profitFactor,
      averageWin,
      averageLoss,
      averageTrade,
      largestWin,
      largestLoss,

      maxDrawdown,
      maxDrawdownPercent,
      currentDrawdown,
      sharpeRatio,
      sortinoRatio,

      currentStreak: this.currentStreak,
      longestWinStreak: this.longestWinStreak,
      longestLossStreak: this.longestLossStreak,

      averageHoldingTimeMs,
      totalTradingDays,

      expectancy,
      expectancyPercent
    };
  }

  /**
   * Get empty metrics for when no trades exist
   */
  private getEmptyMetrics(): PerformanceMetrics {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      breakEvenTrades: 0,
      winRate: 0,
      grossProfit: 0,
      grossLoss: 0,
      netProfit: 0,
      profitFactor: 0,
      averageWin: 0,
      averageLoss: 0,
      averageTrade: 0,
      largestWin: 0,
      largestLoss: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      currentDrawdown: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      currentStreak: 0,
      longestWinStreak: 0,
      longestLossStreak: 0,
      averageHoldingTimeMs: 0,
      totalTradingDays: 0,
      expectancy: 0,
      expectancyPercent: 0
    };
  }

  /**
   * Get all trade records
   */
  public getTrades(): TradeRecord[] {
    return [...this.trades];
  }

  /**
   * Get recent trades
   */
  public getRecentTrades(count: number = 10): TradeRecord[] {
    return this.trades.slice(-count);
  }

  /**
   * Get equity curve
   */
  public getEquityCurve(): number[] {
    return [...this.equityCurve];
  }

  /**
   * Get trades for a specific symbol
   */
  public getTradesForSymbol(symbol: string): TradeRecord[] {
    return this.trades.filter(t => t.symbol === symbol);
  }

  /**
   * Get performance summary as formatted string
   */
  public getPerformanceSummary(): string {
    const metrics = this.getMetrics();

    return `
📊 **Performance Metrics**

**Trade Statistics:**
• Total Trades: ${metrics.totalTrades}
• Winning: ${metrics.winningTrades} | Losing: ${metrics.losingTrades} | Break-even: ${metrics.breakEvenTrades}
• Win Rate: ${metrics.winRate.toFixed(2)}%

**P&L:**
• Net Profit: ₹${metrics.netProfit.toFixed(2)} (${((metrics.netProfit / this.startingBalance) * 100).toFixed(2)}%)
• Gross Profit: ₹${metrics.grossProfit.toFixed(2)}
• Gross Loss: ₹${metrics.grossLoss.toFixed(2)}
• Profit Factor: ${metrics.profitFactor.toFixed(2)}

**Average Performance:**
• Avg Win: ₹${metrics.averageWin.toFixed(2)}
• Avg Loss: ₹${metrics.averageLoss.toFixed(2)}
• Avg Trade: ₹${metrics.averageTrade.toFixed(2)}

**Best/Worst:**
• Largest Win: ₹${metrics.largestWin.toFixed(2)}
• Largest Loss: ₹${metrics.largestLoss.toFixed(2)}

**Risk Metrics:**
• Max Drawdown: ₹${metrics.maxDrawdown.toFixed(2)} (${metrics.maxDrawdownPercent.toFixed(2)}%)
• Current Drawdown: ₹${metrics.currentDrawdown.toFixed(2)}
• Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)}
• Sortino Ratio: ${metrics.sortinoRatio.toFixed(2)}

**Expectancy:**
• Expectancy: ₹${metrics.expectancy.toFixed(2)} per trade
• Expectancy %: ${metrics.expectancyPercent.toFixed(4)}%

**Streaks:**
• Current: ${metrics.currentStreak > 0 ? '+' : ''}${metrics.currentStreak}
• Longest Win Streak: ${metrics.longestWinStreak}
• Longest Loss Streak: ${metrics.longestLossStreak}

**Trading Activity:**
• Trading Days: ${metrics.totalTradingDays}
• Avg Holding Time: ${(metrics.averageHoldingTimeMs / 60000).toFixed(1)} minutes
`.trim();
  }

  /**
   * Reset all metrics (use with caution)
   */
  public reset(newStartingBalance?: number): void {
    this.trades = [];
    this.equityCurve = [];
    this.startingBalance = newStartingBalance || this.startingBalance;
    this.currentBalance = this.startingBalance;
    this.peakBalance = this.startingBalance;
    this.currentStreak = 0;
    this.longestWinStreak = 0;
    this.longestLossStreak = 0;
    this.equityCurve.push(this.startingBalance);

    logger.warn('⚠️  Performance tracker reset', {
      newStartingBalance: this.startingBalance
    });
  }
}
