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
    reason?: string
  ): Promise<void> {
    const emoji = action === 'BUY' ? '🟢' : '🔴';
    const message = `
${emoji} *${action} ORDER*

Symbol: \`${symbol}\`
Quantity: ${quantity}
Price: ₹${price.toFixed(2)}
${reason ? `Reason: ${reason}` : ''}
    `;
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

    const message = `
${statusEmoji} *POSITION ${status}*

Symbol: \`${symbol}\`
${status === 'CLOSED' ? `${emoji} P&L: ₹${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)` : ''}
    `;
    await this.sendMessage(message);
  }

  public async sendRiskAlert(type: string, details: string): Promise<void> {
    await this.sendAlert(`RISK ALERT: ${type}`, details);
  }

  public async sendStatusReport(status: any): Promise<void> {
    const message = `
*📊 Trading Bot Status*

Mode: \`${status.mode}\`
Kill Switch: ${status.killSwitch ? '🔴 ACTIVE' : '🟢 INACTIVE'}
Positions: ${status.positionCount}
Balance: ₹${status.balance.toFixed(2)}
Total P&L: ₹${status.totalPnL.toFixed(2)}
    `;
    await this.sendMessage(message);
  }

  public async sendPositionsReport(positions: any[]): Promise<void> {
    if (positions.length === 0) {
      await this.sendMessage('*No open positions*');
      return;
    }

    let message = '*📈 Open Positions*\n\n';

    for (const pos of positions) {
      const emoji = pos.pnl >= 0 ? '✅' : '❌';
      message += `
${emoji} ${pos.symbol}
Type: ${pos.type}
Qty: ${pos.quantity}
Entry: ₹${pos.entryPrice.toFixed(2)}
Current: ₹${pos.currentPrice.toFixed(2)}
P&L: ₹${pos.pnl.toFixed(2)} (${pos.pnlPercent.toFixed(2)}%)
---
      `;
    }

    await this.sendMessage(message);
  }

  public async sendPnLReport(pnl: any): Promise<void> {
    const emoji = pnl.total >= 0 ? '✅' : '❌';
    const message = `
*💰 P&L Summary*

${emoji} Total P&L: ₹${pnl.total.toFixed(2)}
Starting Balance: ₹${pnl.startingBalance.toFixed(2)}
Current Balance: ₹${pnl.currentBalance.toFixed(2)}
Return: ${pnl.returnPercent.toFixed(2)}%

Today's P&L: ₹${pnl.dailyPnL.toFixed(2)}
Trades Today: ${pnl.tradesExecutedToday}
    `;
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
