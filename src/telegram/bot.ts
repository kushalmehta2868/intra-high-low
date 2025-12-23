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
    target?: number
  ): Promise<void> {
    const emoji = action === 'BUY' ? '🟢' : '🔴';
    const orderValue = quantity * price;

    let message = `${emoji} *${action} ORDER EXECUTED*\n\n`;
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

    if (reason) {
      message += `\n📝 *Reason:* ${reason}`;
    }

    await this.sendMessage(message);
  }

  public async sendPositionUpdate(
    symbol: string,
    pnl: number,
    pnlPercent: number,
    status: 'OPENED' | 'CLOSED'
  ): Promise<void> {
    const emoji = pnl >= 0 ? '✅' : '❌';
    const statusEmoji = status === 'OPENED' ? '📈' : '📉';

    let message = `${statusEmoji} *POSITION ${status}*\n\n`;
    message += `*Symbol:* \`${symbol}\`\n`;

    if (status === 'CLOSED') {
      message += `\n${emoji} *P&L:* ₹${pnl.toLocaleString('en-IN', { maximumFractionDigits: 2 })} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n`;

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

Trades Today: ${stats.tradesExecutedToday}/${stats.maxTradesPerDay}
Trades Remaining: ${stats.tradesRemaining}

Daily P&L: ₹${stats.dailyPnL.toFixed(2)}
Daily Loss: ${stats.dailyLossPercentage.toFixed(2)}%
Max Loss Allowed: ${stats.maxDailyLossPercent}%

${stats.isAtRiskLimit ? '🔴 *AT RISK LIMIT*' : '🟢 Within limits'}
    `;
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
