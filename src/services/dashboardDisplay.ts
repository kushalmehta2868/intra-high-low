import { MetricsTracker, LiveMetrics, DailyMetrics } from './metricsTracker';
import { RiskManager } from '../risk/riskManager';
import { PositionManager } from '../core/positionManager';
import { logger } from '../utils/logger';

/**
 * Dashboard Display Service
 * Generates formatted console and Telegram dashboard displays
 * Shows key metrics at a glance
 */
export class DashboardDisplay {
  private metricsTracker: MetricsTracker;
  private riskManager: RiskManager;
  private positionManager: PositionManager;

  constructor(
    metricsTracker: MetricsTracker,
    riskManager: RiskManager,
    positionManager: PositionManager
  ) {
    this.metricsTracker = metricsTracker;
    this.riskManager = riskManager;
    this.positionManager = positionManager;
  }

  /**
   * Generate console dashboard (for logging)
   */
  public generateConsoleDashboard(): string {
    const live = this.metricsTracker.getLiveMetrics();
    const today = this.metricsTracker.calculateDailyMetrics();
    const positions = this.positionManager.getAllPositions();
    const riskStats = this.riskManager.getRiskStats();

    let dashboard = '\n';
    dashboard += '╔═══════════════════════════════════════════════════════════════╗\n';
    dashboard += '║           TRADING BOT DASHBOARD - LIVE METRICS               ║\n';
    dashboard += '╠═══════════════════════════════════════════════════════════════╣\n';

    // Account Section
    dashboard += '║ 💰 ACCOUNT                                                    ║\n';
    dashboard += '╟───────────────────────────────────────────────────────────────╢\n';
    dashboard += `║   Peak Balance:         ₹${this.formatNumber(live.peakBalance, 10)}                     ║\n`;
    dashboard += `║   Current Balance:      ₹${this.formatNumber(live.currentBalance, 10)}                     ║\n`;
    dashboard += `║   Drawdown:             ₹${this.formatNumber(live.currentDrawdown, 10)} (${this.formatPercent(live.currentDrawdownPercent, 5)})         ║\n`;
    dashboard += '╟───────────────────────────────────────────────────────────────╢\n';

    // Today's Performance
    dashboard += '║ 📈 TODAY\'S PERFORMANCE                                        ║\n';
    dashboard += '╟───────────────────────────────────────────────────────────────╢\n';
    dashboard += `║   P&L:                  ₹${this.formatNumber(today.totalPnL, 10)} (${today.totalPnL >= 0 ? '+' : ''}${this.formatPercent((today.totalPnL / live.peakBalance) * 100, 5)})         ║\n`;
    dashboard += `║   Trades:               ${this.formatNumber(today.totalTrades, 3)} (W:${today.winningTrades} L:${today.losingTrades} BE:${today.breakEvenTrades})               ║\n`;
    dashboard += `║   Win Rate:             ${this.formatPercent(today.winRate, 5)}                              ║\n`;
    dashboard += `║   Avg Slippage:         ${this.formatPercent(today.avgSlippage * 100, 5)}                              ║\n`;
    dashboard += `║   Sharpe Ratio:         ${today.sharpeRatio.toFixed(3).padStart(5)}                                   ║\n`;
    dashboard += '╟───────────────────────────────────────────────────────────────╢\n';

    // Risk Metrics
    dashboard += '║ ⚠️  RISK METRICS                                              ║\n';
    dashboard += '╟───────────────────────────────────────────────────────────────╢\n';
    dashboard += `║   Consecutive Losses:   ${live.consecutiveLosses.toString().padStart(2)} ${this.getStreakIndicator(live.consecutiveLosses, 'loss')}                                  ║\n`;
    dashboard += `║   Consecutive Wins:     ${live.consecutiveWins.toString().padStart(2)} ${this.getStreakIndicator(live.consecutiveWins, 'win')}                                  ║\n`;
    dashboard += `║   Max Drawdown Today:   ${this.formatPercent(today.maxDrawdown, 5)}                              ║\n`;
    dashboard += `║   Daily Loss Limit:     ${this.formatPercent(riskStats.maxDailyLossPercent, 5)} (Used: ${this.formatPercent(riskStats.dailyLossPercentage, 4)})          ║\n`;
    dashboard += `║   Trades Remaining:     ${riskStats.tradesRemaining.toString().padStart(2)}/${riskStats.maxTradesPerDay.toString().padStart(2)}                                       ║\n`;
    dashboard += '╟───────────────────────────────────────────────────────────────╢\n';

    // Open Positions
    dashboard += '║ 📦 OPEN POSITIONS                                             ║\n';
    dashboard += '╟───────────────────────────────────────────────────────────────╢\n';

    if (positions.length === 0) {
      dashboard += '║   No open positions                                           ║\n';
    } else {
      for (const pos of positions.slice(0, 5)) {
        const pnlSymbol = pos.pnl >= 0 ? '+' : '';
        const posType = pos.type === 'LONG' ? '📈' : '📉';
        dashboard += `║   ${posType} ${pos.symbol.padEnd(12)} Q:${pos.quantity.toString().padStart(4)} P&L:${pnlSymbol}₹${pos.pnl.toFixed(0).padStart(6)}           ║\n`;
      }

      if (positions.length > 5) {
        dashboard += `║   ... and ${positions.length - 5} more                                           ║\n`;
      }
    }

    dashboard += '╚═══════════════════════════════════════════════════════════════╝\n';

    return dashboard;
  }

  /**
   * Generate Telegram dashboard (formatted for Telegram)
   */
  public generateTelegramDashboard(): string {
    const live = this.metricsTracker.getLiveMetrics();
    const today = this.metricsTracker.calculateDailyMetrics();
    const positions = this.positionManager.getAllPositions();
    const riskStats = this.riskManager.getRiskStats();

    let msg = '📊 *TRADING DASHBOARD*\n\n';

    // Account
    msg += '💰 *Account*\n';
    msg += `Peak: ₹${live.peakBalance.toLocaleString('en-IN')}\n`;
    msg += `Current: ₹${live.currentBalance.toLocaleString('en-IN')}\n`;
    msg += `Drawdown: ${live.currentDrawdownPercent >= 0 ? '-' : '+'}${live.currentDrawdownPercent.toFixed(2)}% (₹${live.currentDrawdown.toFixed(0)})\n\n`;

    // Today's Performance
    msg += '📈 *Today\'s Performance*\n';
    const pnlEmoji = today.totalPnL >= 0 ? '✅' : '❌';
    msg += `P&L: ${pnlEmoji} ₹${today.totalPnL.toFixed(2)} (${today.totalPnL >= 0 ? '+' : ''}${((today.totalPnL / live.peakBalance) * 100).toFixed(2)}%)\n`;
    msg += `Trades: ${today.totalTrades} (W:${today.winningTrades} L:${today.losingTrades})\n`;
    msg += `Win Rate: ${today.winRate.toFixed(1)}%\n`;
    msg += `Avg Slippage: ${(today.avgSlippage * 100).toFixed(3)}%\n`;
    msg += `Sharpe: ${today.sharpeRatio.toFixed(3)}\n\n`;

    // Risk
    msg += '⚠️ *Risk Status*\n';

    if (live.consecutiveLosses > 0) {
      msg += `🔴 Consecutive Losses: ${live.consecutiveLosses}`;
      if (live.consecutiveLosses >= 2) {
        msg += ' ⚠️ WARNING!';
      }
      msg += '\n';
    } else if (live.consecutiveWins > 0) {
      msg += `🟢 Consecutive Wins: ${live.consecutiveWins}\n`;
    } else {
      msg += `No active streak\n`;
    }

    msg += `Trades Left: ${riskStats.tradesRemaining}/${riskStats.maxTradesPerDay}\n`;
    msg += `Daily Loss Used: ${riskStats.dailyLossPercentage.toFixed(2)}% / ${riskStats.maxDailyLossPercent}%\n\n`;

    // Positions
    msg += '📦 *Open Positions*\n';
    if (positions.length === 0) {
      msg += 'None\n';
    } else {
      for (const pos of positions.slice(0, 5)) {
        const emoji = pos.type === 'LONG' ? '📈' : '📉';
        const pnlEmoji = pos.pnl >= 0 ? '✅' : '❌';
        msg += `${emoji} \`${pos.symbol}\`: ${pnlEmoji} ₹${pos.pnl.toFixed(0)} (${pos.pnlPercent.toFixed(2)}%)\n`;
      }

      if (positions.length > 5) {
        msg += `_...and ${positions.length - 5} more_\n`;
      }
    }

    msg += `\n⏰ _Updated: ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}_`;

    return msg;
  }

  /**
   * Generate performance summary report
   */
  public generatePerformanceSummary(): string {
    const allTrades = this.metricsTracker.getAllTrades();

    if (allTrades.length === 0) {
      return '📊 No trades executed yet.';
    }

    const wins = allTrades.filter(t => t.result === 'WIN');
    const losses = allTrades.filter(t => t.result === 'LOSS');

    const totalPnL = allTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length : 0;
    const profitFactor = losses.length > 0 ? Math.abs(wins.reduce((sum, t) => sum + t.pnl, 0) / losses.reduce((sum, t) => sum + t.pnl, 0)) : 0;

    const avgHoldTime = allTrades.reduce((sum, t) => sum + t.holdTimeMs, 0) / allTrades.length;
    const avgSlippage = allTrades.reduce((sum, t) => sum + t.actualSlippage, 0) / allTrades.length;

    let report = '📊 *PERFORMANCE SUMMARY*\n\n';
    report += `Total Trades: ${allTrades.length}\n`;
    report += `Win Rate: ${((wins.length / allTrades.length) * 100).toFixed(2)}%\n`;
    report += `Total P&L: ₹${totalPnL.toFixed(2)}\n\n`;

    report += `Avg Win: ₹${avgWin.toFixed(2)}\n`;
    report += `Avg Loss: ₹${avgLoss.toFixed(2)}\n`;
    report += `Profit Factor: ${profitFactor.toFixed(2)}\n\n`;

    report += `Avg Hold Time: ${(avgHoldTime / 60000).toFixed(1)} min\n`;
    report += `Avg Slippage: ${(avgSlippage * 100).toFixed(3)}%\n`;

    return report;
  }

  /**
   * Display dashboard to console
   */
  public displayConsole(): void {
    const dashboard = this.generateConsoleDashboard();
    console.log(dashboard);
  }

  /**
   * Helper: Format number with padding
   */
  private formatNumber(num: number, width: number): string {
    return num.toFixed(2).padStart(width);
  }

  /**
   * Helper: Format percentage with padding
   */
  private formatPercent(num: number, width: number): string {
    return (num.toFixed(2) + '%').padStart(width);
  }

  /**
   * Helper: Get streak indicator
   */
  private getStreakIndicator(count: number, type: 'win' | 'loss'): string {
    if (count === 0) return '  ';
    if (type === 'loss') {
      if (count >= 3) return '🚨';
      if (count >= 2) return '⚠️ ';
      return '⚠️ ';
    } else {
      if (count >= 3) return '🔥';
      if (count >= 2) return '✨';
      return '✨';
    }
  }
}
