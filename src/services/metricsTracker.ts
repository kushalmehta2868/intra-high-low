import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

export interface TradeMetrics {
  symbol: string;
  entryTime: Date;
  exitTime: Date;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  expectedSlippage: number;
  actualSlippage: number;
  holdTimeMs: number;
  result: 'WIN' | 'LOSS' | 'BREAKEVEN';
  exitReason: 'TARGET' | 'STOP_LOSS' | 'MANUAL' | 'AUTO_SQUARE_OFF' | 'TIME_BASED';
}

export interface DailyMetrics {
  date: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;
  winRate: number;
  totalPnL: number;
  largestWin: number;
  largestLoss: number;
  avgSlippage: number;
  maxSlippage: number;
  avgHoldTimeMs: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  maxDrawdown: number;
  sharpeRatio: number;
  capitalDeployed: number;
  capitalEfficiency: number; // PnL per rupee deployed
}

export interface LiveMetrics {
  currentDrawdown: number;
  currentDrawdownPercent: number;
  peakBalance: number;
  currentBalance: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  todayPnL: number;
  todayWinRate: number;
  avgSlippageToday: number;
  tradesExecutedToday: number;
}

/**
 * Comprehensive Metrics Tracker
 * Tracks all trading metrics for performance analysis and risk management
 */
export class MetricsTracker extends EventEmitter {
  private trades: TradeMetrics[] = [];
  private dailyMetrics: Map<string, DailyMetrics> = new Map();

  // Live tracking
  private startingBalance: number = 0;
  private currentBalance: number = 0;
  private peakBalance: number = 0;
  private consecutiveLosses: number = 0;
  private consecutiveWins: number = 0;

  // CSV export path
  private readonly EXPORT_DIR = path.join(process.cwd(), 'exports');
  private readonly TRADES_CSV = path.join(this.EXPORT_DIR, 'trades.csv');
  private readonly DAILY_CSV = path.join(this.EXPORT_DIR, 'daily_metrics.csv');

  constructor(initialBalance: number) {
    super();
    this.startingBalance = initialBalance;
    this.currentBalance = initialBalance;
    this.peakBalance = initialBalance;

    // Ensure export directory exists
    if (!fs.existsSync(this.EXPORT_DIR)) {
      fs.mkdirSync(this.EXPORT_DIR, { recursive: true });
    }

    // Initialize CSV files with headers if they don't exist
    this.initializeCSVFiles();
  }

  /**
   * Record a completed trade
   */
  public recordTrade(trade: TradeMetrics): void {
    this.trades.push(trade);

    // Update balance
    this.currentBalance += trade.pnl;

    // Update peak balance
    if (this.currentBalance > this.peakBalance) {
      this.peakBalance = this.currentBalance;
    }

    // Update consecutive win/loss streaks
    if (trade.result === 'WIN') {
      this.consecutiveWins++;
      this.consecutiveLosses = 0;
    } else if (trade.result === 'LOSS') {
      this.consecutiveLosses++;
      this.consecutiveWins = 0;
    } else {
      // BREAKEVEN resets both
      this.consecutiveWins = 0;
      this.consecutiveLosses = 0;
    }

    // Log trade
    logger.info('Trade recorded in metrics', {
      symbol: trade.symbol,
      pnl: trade.pnl.toFixed(2),
      pnlPercent: trade.pnlPercent.toFixed(2) + '%',
      slippage: trade.actualSlippage.toFixed(2) + '%',
      result: trade.result,
      consecutiveLosses: this.consecutiveLosses,
      consecutiveWins: this.consecutiveWins
    });

    // Export to CSV
    this.exportTradeToCSV(trade);

    // Check for alerts
    this.checkMetricAlerts(trade);

    this.emit('trade_recorded', trade);
  }

  /**
   * Get live metrics
   */
  public getLiveMetrics(): LiveMetrics {
    const today = new Date().toISOString().split('T')[0];
    const todayTrades = this.trades.filter(t =>
      t.exitTime.toISOString().split('T')[0] === today
    );

    const todayWins = todayTrades.filter(t => t.result === 'WIN').length;
    const todayPnL = todayTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgSlippage = todayTrades.length > 0
      ? todayTrades.reduce((sum, t) => sum + t.actualSlippage, 0) / todayTrades.length
      : 0;

    return {
      currentDrawdown: this.peakBalance - this.currentBalance,
      currentDrawdownPercent: ((this.peakBalance - this.currentBalance) / this.peakBalance) * 100,
      peakBalance: this.peakBalance,
      currentBalance: this.currentBalance,
      consecutiveLosses: this.consecutiveLosses,
      consecutiveWins: this.consecutiveWins,
      todayPnL,
      todayWinRate: todayTrades.length > 0 ? (todayWins / todayTrades.length) * 100 : 0,
      avgSlippageToday: avgSlippage,
      tradesExecutedToday: todayTrades.length
    };
  }

  /**
   * Calculate daily metrics
   */
  public calculateDailyMetrics(date?: string): DailyMetrics {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const dayTrades = this.trades.filter(t =>
      t.exitTime.toISOString().split('T')[0] === targetDate
    );

    if (dayTrades.length === 0) {
      return this.getEmptyDailyMetrics(targetDate);
    }

    const wins = dayTrades.filter(t => t.result === 'WIN');
    const losses = dayTrades.filter(t => t.result === 'LOSS');
    const breakEvens = dayTrades.filter(t => t.result === 'BREAKEVEN');

    const totalPnL = dayTrades.reduce((sum, t) => sum + t.pnl, 0);
    const largestWin = wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0;
    const largestLoss = losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0;

    const avgSlippage = dayTrades.reduce((sum, t) => sum + t.actualSlippage, 0) / dayTrades.length;
    const maxSlippage = Math.max(...dayTrades.map(t => t.actualSlippage));

    const avgHoldTime = dayTrades.reduce((sum, t) => sum + t.holdTimeMs, 0) / dayTrades.length;

    // Calculate drawdown for the day
    let runningBalance = this.startingBalance;
    let peak = runningBalance;
    let maxDD = 0;

    for (const trade of dayTrades) {
      runningBalance += trade.pnl;
      if (runningBalance > peak) peak = runningBalance;
      const dd = ((peak - runningBalance) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }

    // Calculate Sharpe Ratio (simplified daily version)
    const returns = dayTrades.map(t => t.pnlPercent);
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const stdDev = Math.sqrt(
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    );
    const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

    // Calculate capital deployed (sum of all order values)
    const capitalDeployed = dayTrades.reduce((sum, t) =>
      sum + (t.entryPrice * t.quantity), 0
    );

    const capitalEfficiency = capitalDeployed > 0 ? totalPnL / capitalDeployed : 0;

    const metrics: DailyMetrics = {
      date: targetDate,
      totalTrades: dayTrades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      breakEvenTrades: breakEvens.length,
      winRate: (wins.length / dayTrades.length) * 100,
      totalPnL,
      largestWin,
      largestLoss,
      avgSlippage,
      maxSlippage,
      avgHoldTimeMs: avgHoldTime,
      consecutiveLosses: this.calculateMaxConsecutiveLosses(dayTrades),
      consecutiveWins: this.calculateMaxConsecutiveWins(dayTrades),
      maxDrawdown: maxDD,
      sharpeRatio,
      capitalDeployed,
      capitalEfficiency
    };

    this.dailyMetrics.set(targetDate, metrics);
    this.exportDailyMetricsToCSV(metrics);

    return metrics;
  }

  /**
   * Get all trades
   */
  public getAllTrades(): TradeMetrics[] {
    return [...this.trades];
  }

  /**
   * Get trades for a specific date
   */
  public getTradesByDate(date: string): TradeMetrics[] {
    return this.trades.filter(t =>
      t.exitTime.toISOString().split('T')[0] === date
    );
  }

  /**
   * Update current balance (called by risk manager)
   */
  public updateBalance(balance: number): void {
    this.currentBalance = balance;

    if (balance > this.peakBalance) {
      this.peakBalance = balance;
    }
  }

  /**
   * Reset for new trading day
   */
  public resetDailyCounters(): void {
    // Don't reset trades, but calculate yesterday's metrics
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    this.calculateDailyMetrics(yesterdayStr);

    logger.info('Daily metrics calculated and archived', { date: yesterdayStr });
  }

  /**
   * Initialize CSV files with headers
   */
  private initializeCSVFiles(): void {
    // Trades CSV
    if (!fs.existsSync(this.TRADES_CSV)) {
      const headers = 'Date,Symbol,Side,EntryTime,ExitTime,EntryPrice,ExitPrice,Quantity,PnL,PnL%,ExpectedSlippage%,ActualSlippage%,HoldTimeMin,Result,ExitReason\n';
      fs.writeFileSync(this.TRADES_CSV, headers);
    }

    // Daily Metrics CSV
    if (!fs.existsSync(this.DAILY_CSV)) {
      const headers = 'Date,TotalTrades,Wins,Losses,WinRate%,TotalPnL,LargestWin,LargestLoss,AvgSlippage%,MaxSlippage%,MaxDrawdown%,SharpeRatio,CapitalEfficiency\n';
      fs.writeFileSync(this.DAILY_CSV, headers);
    }
  }

  /**
   * Export trade to CSV
   */
  private exportTradeToCSV(trade: TradeMetrics): void {
    const row = [
      trade.exitTime.toISOString().split('T')[0],
      trade.symbol,
      trade.side,
      trade.entryTime.toISOString(),
      trade.exitTime.toISOString(),
      trade.entryPrice.toFixed(2),
      trade.exitPrice.toFixed(2),
      trade.quantity,
      trade.pnl.toFixed(2),
      trade.pnlPercent.toFixed(2),
      (trade.expectedSlippage * 100).toFixed(3),
      (trade.actualSlippage * 100).toFixed(3),
      (trade.holdTimeMs / 60000).toFixed(2), // Convert to minutes
      trade.result,
      trade.exitReason
    ].join(',') + '\n';

    fs.appendFileSync(this.TRADES_CSV, row);
  }

  /**
   * Export daily metrics to CSV
   */
  private exportDailyMetricsToCSV(metrics: DailyMetrics): void {
    const row = [
      metrics.date,
      metrics.totalTrades,
      metrics.winningTrades,
      metrics.losingTrades,
      metrics.winRate.toFixed(2),
      metrics.totalPnL.toFixed(2),
      metrics.largestWin.toFixed(2),
      metrics.largestLoss.toFixed(2),
      (metrics.avgSlippage * 100).toFixed(3),
      (metrics.maxSlippage * 100).toFixed(3),
      metrics.maxDrawdown.toFixed(2),
      metrics.sharpeRatio.toFixed(3),
      metrics.capitalEfficiency.toFixed(4)
    ].join(',') + '\n';

    fs.appendFileSync(this.DAILY_CSV, row);
  }

  /**
   * Check for metric-based alerts
   */
  private checkMetricAlerts(trade: TradeMetrics): void {
    const live = this.getLiveMetrics();

    // High slippage alert
    if (trade.actualSlippage > 0.003) {
      this.emit('high_slippage', {
        symbol: trade.symbol,
        slippage: trade.actualSlippage,
        expected: trade.expectedSlippage
      });
    }

    // Consecutive losses alert
    if (this.consecutiveLosses === 2) {
      this.emit('consecutive_losses_warning', {
        count: this.consecutiveLosses,
        message: 'One more loss triggers circuit breaker'
      });
    }

    // Drawdown alert
    if (live.currentDrawdownPercent > 10) {
      this.emit('high_drawdown', {
        drawdown: live.currentDrawdown,
        drawdownPercent: live.currentDrawdownPercent,
        peakBalance: live.peakBalance
      });
    }
  }

  /**
   * Helper methods
   */
  private calculateMaxConsecutiveLosses(trades: TradeMetrics[]): number {
    let max = 0;
    let current = 0;

    for (const trade of trades) {
      if (trade.result === 'LOSS') {
        current++;
        max = Math.max(max, current);
      } else {
        current = 0;
      }
    }

    return max;
  }

  private calculateMaxConsecutiveWins(trades: TradeMetrics[]): number {
    let max = 0;
    let current = 0;

    for (const trade of trades) {
      if (trade.result === 'WIN') {
        current++;
        max = Math.max(max, current);
      } else {
        current = 0;
      }
    }

    return max;
  }

  private getEmptyDailyMetrics(date: string): DailyMetrics {
    return {
      date,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      breakEvenTrades: 0,
      winRate: 0,
      totalPnL: 0,
      largestWin: 0,
      largestLoss: 0,
      avgSlippage: 0,
      maxSlippage: 0,
      avgHoldTimeMs: 0,
      consecutiveLosses: 0,
      consecutiveWins: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      capitalDeployed: 0,
      capitalEfficiency: 0
    };
  }

  /**
   * Get summary report for display
   */
  public getSummaryReport(): string {
    const live = this.getLiveMetrics();
    const today = this.calculateDailyMetrics();

    let report = '📊 TRADING METRICS SUMMARY\n';
    report += '='.repeat(50) + '\n\n';

    report += '💰 Account Status:\n';
    report += `  Peak Balance: ₹${live.peakBalance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;
    report += `  Current Balance: ₹${live.currentBalance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;
    report += `  Drawdown: ₹${live.currentDrawdown.toFixed(2)} (${live.currentDrawdownPercent.toFixed(2)}%)\n\n`;

    report += '📈 Today\'s Performance:\n';
    report += `  Trades: ${today.totalTrades} (W: ${today.winningTrades}, L: ${today.losingTrades})\n`;
    report += `  Win Rate: ${today.winRate.toFixed(2)}%\n`;
    report += `  P&L: ₹${today.totalPnL.toFixed(2)}\n`;
    report += `  Avg Slippage: ${(today.avgSlippage * 100).toFixed(3)}%\n`;
    report += `  Sharpe Ratio: ${today.sharpeRatio.toFixed(3)}\n\n`;

    report += '⚠️  Risk Metrics:\n';
    report += `  Consecutive Losses: ${live.consecutiveLosses}\n`;
    report += `  Consecutive Wins: ${live.consecutiveWins}\n`;
    report += `  Max Drawdown Today: ${today.maxDrawdown.toFixed(2)}%\n`;

    return report;
  }
}
