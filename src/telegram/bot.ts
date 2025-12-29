import TelegramBot from 'node-telegram-bot-api';
import { TelegramConfig } from '../types';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

export class TradingTelegramBot extends EventEmitter {
  private bot: TelegramBot | null = null;
  private chatId: string = '';
  private isRunning: boolean = false;

  constructor(config: TelegramConfig) {
    super();

    if (config.botToken) {
      // Initialize bot WITHOUT polling - notification only mode
      // This prevents the 409 "Another bot instance is running" error completely!
      this.bot = new TelegramBot(config.botToken, {
        polling: false  // NO POLLING = NO CONFLICTS!
      });
      this.chatId = config.chatId;
      logger.info('📱 Telegram bot initialized (notification-only mode)');
    } else {
      logger.warn('⚠️ Telegram bot token not configured - notifications disabled');
    }
  }

  public async sendMessage(message: string, options?: any): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not configured, skipping message');
      return;
    }

    try {
      // Truncate long messages (Telegram limit is 4096 characters)
      let truncatedMessage = message;
      if (message.length > 4000) {
        truncatedMessage = message.substring(0, 3950) + '\n\n... (message truncated)';
        logger.warn(`📱 Message truncated from ${message.length} to 4000 characters`);
      }

      // Try sending with Markdown first
      await this.bot.sendMessage(this.chatId, truncatedMessage, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...options
      });

      logger.info('📱 Message sent to Telegram');
    } catch (error) {
      logger.error('Failed to send Telegram message with Markdown:', {
        message: (error as any).message,
        response: (error as any).response?.body
      });

      // Try sending without Markdown as fallback
      try {
        await this.bot.sendMessage(this.chatId, message, {
          disable_web_page_preview: true
        });
        logger.info('📱 Message sent to Telegram (plain text fallback)');
      } catch (fallbackError) {
        logger.error('Fallback plain text message also failed:', {
          message: (fallbackError as any).message
        });
      }
    }
  }

  public async sendAlert(title: string, message: string): Promise<void> {
    const alertMessage = `
*🚨 ${title}*

${message}
    `;
    await this.sendMessage(alertMessage);
  }

  public async sendTradeNotification(
    action: string,
    symbol: string,
    quantity: number,
    price: number,
    reason?: string,
    stopLoss?: number,
    target?: number,
    accountBalance?: number,
    openPositions?: number
  ): Promise<void> {
    const emoji = action === 'BUY' ? '🟢' : '🔴';
    const orderValue = quantity * price;
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    let message = `${emoji} *${action} ORDER EXECUTED*\n\n`;
    message += `🕐 *Time:* ${timeStr}\n`;
    message += `*Symbol:* \`${symbol}\`\n`;
    message += `*Quantity:* ${quantity}\n`;
    message += `*Entry Price:* ₹${price.toFixed(2)}\n`;
    message += `*Order Value:* ₹${orderValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;

    if (stopLoss) {
      const slDiff = Math.abs(price - stopLoss);
      const slPercent = ((slDiff / price) * 100).toFixed(2);
      message += `\n*Stop Loss:* ₹${stopLoss.toFixed(2)} (${slPercent}% risk)\n`;
    }

    if (target) {
      const targetDiff = Math.abs(target - price);
      const targetPercent = ((targetDiff / price) * 100).toFixed(2);
      message += `*Target:* ₹${target.toFixed(2)} (${targetPercent}% gain)\n`;
    }

    if (stopLoss && target) {
      const riskAmount = Math.abs(price - stopLoss) * quantity;
      const rewardAmount = Math.abs(target - price) * quantity;
      const riskRewardRatio = (rewardAmount / riskAmount).toFixed(2);
      message += `\n*Risk:Reward* = 1:${riskRewardRatio}\n`;
      message += `*Max Risk:* ₹${riskAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;
      message += `*Max Reward:* ₹${rewardAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;
    }

    if (accountBalance !== undefined || openPositions !== undefined) {
      message += `\n───────────────────\n`;
      if (accountBalance !== undefined) {
        message += `*Account Balance:* ₹${accountBalance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;
      }
      if (openPositions !== undefined) {
        message += `*Open Positions:* ${openPositions}\n`;
      }
    }

    if (reason) {
      message += `\n📝 *Reason:* ${reason}`;
    }

    await this.sendMessage(message);
  }

  public async sendPositionUpdate(
    symbol: string,
    pnl: number,
    pnlPercent: number,
    status: 'OPENED' | 'CLOSED',
    additionalInfo?: {
      entryPrice?: number;
      exitPrice?: number;
      quantity?: number;
      entryTime?: Date;
      exitTime?: Date;
    }
  ): Promise<void> {
    const emoji = pnl >= 0 ? '✅' : '❌';
    const statusEmoji = status === 'OPENED' ? '📈' : '📉';
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    let message = `${statusEmoji} *POSITION ${status}*\n\n`;
    message += `🕐 *Time:* ${timeStr}\n`;
    message += `*Symbol:* \`${symbol}\`\n`;

    if (status === 'CLOSED' && additionalInfo) {
      message += `\n`;
      if (additionalInfo.quantity) {
        message += `*Quantity:* ${additionalInfo.quantity}\n`;
      }
      if (additionalInfo.entryPrice) {
        message += `*Entry Price:* ₹${additionalInfo.entryPrice.toFixed(2)}\n`;
      }
      if (additionalInfo.exitPrice) {
        message += `*Exit Price:* ₹${additionalInfo.exitPrice.toFixed(2)}\n`;
      }
      message += `\n${emoji} *P&L:* ₹${pnl.toLocaleString('en-IN', { maximumFractionDigits: 2 })} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n`;

      if (additionalInfo.entryTime && additionalInfo.exitTime) {
        const holdingTime = (additionalInfo.exitTime.getTime() - additionalInfo.entryTime.getTime()) / 60000; // minutes
        const hours = Math.floor(holdingTime / 60);
        const minutes = Math.floor(holdingTime % 60);
        message += `\n⏱️ *Holding Time:* ${hours > 0 ? `${hours}h ` : ''}${minutes}m`;
      }

      if (pnl >= 0) {
        message += `\n🎯 *Profit Trade*`;
      } else {
        message += `\n⚠️ *Loss Trade*`;
      }
    }

    await this.sendMessage(message);
  }

  public async sendRiskAlert(type: string, details: string): Promise<void> {
    await this.sendAlert(`RISK ALERT: ${type}`, details);
  }

  public async sendStatusReport(status: any): Promise<void> {
    const killSwitchStatus = status.killSwitch ? '🔴 ACTIVE (Trading Disabled)' : '🟢 INACTIVE';
    const pnlEmoji = status.totalPnL >= 0 ? '📈' : '📉';

    let message = `📊 *TRADING BOT STATUS*\n\n`;
    message += `*Mode:* \`${status.mode}\`\n`;
    message += `*Kill Switch:* ${killSwitchStatus}\n`;
    message += `*Open Positions:* ${status.positionCount}\n`;
    message += `*Account Balance:* ₹${status.balance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;
    message += `${pnlEmoji} *Total P&L:* ₹${status.totalPnL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

    await this.sendMessage(message);
  }

  public async sendPositionsReport(positions: any[]): Promise<void> {
    if (positions.length === 0) {
      await this.sendMessage('📊 *OPEN POSITIONS*\n\n❌ No open positions');
      return;
    }

    let totalPnL = 0;
    let message = `📊 *OPEN POSITIONS (${positions.length})*\n\n`;

    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      const emoji = pos.pnl >= 0 ? '✅' : '❌';
      totalPnL += pos.pnl;

      message += `${i + 1}. ${emoji} *${pos.symbol}*\n`;
      message += `   *Type:* ${pos.type}\n`;
      message += `   *Qty:* ${pos.quantity}\n`;
      message += `   *Entry:* ₹${pos.entryPrice.toFixed(2)}\n`;
      message += `   *Current:* ₹${pos.currentPrice.toFixed(2)}\n`;
      message += `   *P&L:* ₹${pos.pnl.toLocaleString('en-IN', { maximumFractionDigits: 2 })} (${pos.pnlPercent >= 0 ? '+' : ''}${pos.pnlPercent.toFixed(2)}%)\n`;

      if (pos.stopLoss) {
        message += `   *SL:* ₹${pos.stopLoss.toFixed(2)}\n`;
      }
      if (pos.target) {
        message += `   *Target:* ₹${pos.target.toFixed(2)}\n`;
      }

      message += `\n`;
    }

    message += `───────────────────\n`;
    message += `*Total P&L:* ₹${totalPnL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

    await this.sendMessage(message);
  }

  public async sendPnLReport(pnl: any): Promise<void> {
    const emoji = pnl.total >= 0 ? '📈' : '📉';
    const returnEmoji = pnl.returnPercent >= 0 ? '✅' : '❌';

    let message = `💰 *P&L SUMMARY*\n\n`;
    message += `${emoji} *Total P&L:* ₹${pnl.total.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n\n`;
    message += `*Starting Balance:* ₹${pnl.startingBalance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;
    message += `*Current Balance:* ₹${pnl.currentBalance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;
    message += `${returnEmoji} *Return:* ${pnl.returnPercent >= 0 ? '+' : ''}${pnl.returnPercent.toFixed(2)}%\n\n`;
    message += `───────────────────\n\n`;
    message += `*Today's P&L:* ₹${pnl.dailyPnL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;
    message += `*Trades Executed:* ${pnl.tradesExecutedToday}`;

    await this.sendMessage(message);
  }

  public async sendRiskStatsReport(stats: any): Promise<void> {
    const message = `
*⚠️ Risk Statistics*

Daily P&L: ₹${stats.dailyPnL.toFixed(2)}
Daily Loss: ${stats.dailyLossPercentage.toFixed(2)}%
Max Loss Allowed: ${stats.maxDailyLossPercent}%

${stats.isAtRiskLimit ? '🔴 *AT RISK LIMIT*' : '🟢 Within limits'}
    `;
    await this.sendMessage(message);
  }

  public async sendDailySummary(data: {
    dailyPnL: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    breakEvenTrades: number;
    winRate: number;
    largestWin: number;
    largestLoss: number;
    trades: any[];
    startingBalance: number;
    endingBalance: number;
  }): Promise<void> {
    const emoji = data.dailyPnL >= 0 ? '📈' : '📉';
    const pnlEmoji = data.dailyPnL >= 0 ? '✅' : '❌';
    const returnPercent = ((data.dailyPnL / data.startingBalance) * 100).toFixed(2);

    let message = `📊 *DAILY TRADING SUMMARY*\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Performance Summary
    message += `${emoji} *Performance*\n`;
    message += `${pnlEmoji} Net P&L: ₹${data.dailyPnL.toLocaleString('en-IN', { maximumFractionDigits: 2 })} (${returnPercent >= '0' ? '+' : ''}${returnPercent}%)\n`;
    message += `💰 Starting: ₹${data.startingBalance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;
    message += `💵 Ending: ₹${data.endingBalance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n\n`;

    // Trade Statistics
    message += `📊 *Trade Statistics*\n`;
    message += `Total Trades: ${data.totalTrades}\n`;
    message += `✅ Wins: ${data.winningTrades}\n`;
    message += `❌ Losses: ${data.losingTrades}\n`;
    message += `➖ Break-even: ${data.breakEvenTrades}\n`;
    message += `📈 Win Rate: ${data.winRate.toFixed(1)}%\n\n`;

    if (data.totalTrades > 0) {
      message += `🏆 Largest Win: ₹${data.largestWin.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;
      message += `💔 Largest Loss: ₹${data.largestLoss.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n\n`;
    }

    // Trade Details Table
    if (data.trades.length > 0) {
      message += `━━━━━━━━━━━━━━━━━━━━\n`;
      message += `*📋 Trade Details*\n\n`;

      message += `\`\`\`\n`;
      message += `Symbol    Side  P&L      %\n`;
      message += `────────────────────────\n`;

      for (const trade of data.trades) {
        const symbol = trade.symbol.replace('-EQ', '').padEnd(9);
        const side = trade.side.padEnd(4);
        const pnl = (trade.pnl >= 0 ? '+' : '') + trade.pnl.toFixed(0);
        const pnlFormatted = pnl.padStart(8);
        const percent = (trade.pnlPercent >= 0 ? '+' : '') + trade.pnlPercent.toFixed(1) + '%';

        message += `${symbol} ${side} ${pnlFormatted} ${percent}\n`;
      }

      message += `\`\`\`\n`;
    } else {
      message += `━━━━━━━━━━━━━━━━━━━━\n`;
      message += `No trades executed today\n`;
    }

    message += `\n🕐 Report generated at ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;

    await this.sendMessage(message);
  }

  public async start(): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not configured, skipping startup');
      return;
    }

    if (this.isRunning) {
      logger.warn('Telegram bot already running');
      return;
    }

    try {
      logger.info('🔧 Starting Telegram notification bot...');

      // Verify bot credentials
      const botInfo = await this.bot.getMe();
      logger.info(`📱 Telegram bot verified: @${botInfo.username}`);

      // NO POLLING NEEDED - Just verify the bot works
      // Send a test to verify we can send messages
      logger.info('✅ Bot is ready to send notifications');
      logger.info('ℹ️  Note: Commands like /status are disabled (notification-only mode)');

      this.isRunning = true;
      logger.info('✅ Telegram notification bot started successfully');
    } catch (error: any) {
      logger.error('❌ Failed to start Telegram bot:', error.message);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.bot) {
      return;
    }

    if (!this.isRunning) {
      logger.warn('Telegram bot already stopped');
      return;
    }

    logger.info('🛑 Stopping Telegram bot...');
    this.isRunning = false;

    // No polling to stop - just mark as stopped
    logger.info('✅ Telegram notification bot stopped');
  }
}
