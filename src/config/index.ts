import dotenv from 'dotenv';
import { AppConfig, TradingMode, TradingConfig, BrokerConfig, TelegramConfig } from '../types';

dotenv.config();

class ConfigManager {
  private config: AppConfig;

  constructor() {
    this.config = this.loadConfig();
    this.validateConfig();
  }

  private loadConfig(): AppConfig {
    return {
      trading: this.loadTradingConfig(),
      broker: this.loadBrokerConfig(),
      telegram: this.loadTelegramConfig(),
      logLevel: process.env.LOG_LEVEL || 'info',
      enableAuditLog: process.env.ENABLE_AUDIT_LOG === 'true'
    };
  }

  private loadTradingConfig(): TradingConfig {
    const mode = process.env.TRADING_MODE?.toUpperCase() as TradingMode;

    return {
      mode: mode === TradingMode.REAL ? TradingMode.REAL : TradingMode.PAPER,
      autoSquareOffTime: process.env.AUTO_SQUARE_OFF_TIME || '15:20',
      marketStartTime: process.env.MARKET_START_TIME || '09:15',
      marketEndTime: process.env.MARKET_END_TIME || '15:30',
      killSwitch: process.env.KILL_SWITCH === 'true',
      riskLimits: {
        maxRiskPerTradePercent: parseFloat(process.env.MAX_RISK_PER_TRADE_PERCENT || '2'),
        maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || '5'),
        maxDailyLossPercent: parseFloat(process.env.MAX_DAILY_LOSS_PERCENT || '5'),
        positionSizePercent: parseFloat(process.env.POSITION_SIZE_PERCENT || '10'),
        marginMultiplier: parseFloat(process.env.MARGIN_MULTIPLIER || '5'),
        useMargin: process.env.USE_MARGIN !== 'false'
      }
    };
  }

  private loadBrokerConfig(): BrokerConfig {
    return {
      apiKey: process.env.ANGEL_API_KEY || '',
      clientId: process.env.ANGEL_CLIENT_ID || '',
      password: process.env.ANGEL_PASSWORD || '',
      totpSecret: process.env.ANGEL_TOTP_SECRET || ''
    };
  }

  private loadTelegramConfig(): TelegramConfig {
    return {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || ''
    };
  }

  private validateConfig(): void {
    const errors: string[] = [];

    if (this.config.trading.mode === TradingMode.REAL) {
      if (!this.config.broker.apiKey) errors.push('ANGEL_API_KEY is required for REAL mode');
      if (!this.config.broker.clientId) errors.push('ANGEL_CLIENT_ID is required for REAL mode');
      if (!this.config.broker.password) errors.push('ANGEL_PASSWORD is required for REAL mode');
      if (!this.config.broker.totpSecret) errors.push('ANGEL_TOTP_SECRET is required for REAL mode');
    }

    if (!this.config.telegram.botToken) {
      errors.push('TELEGRAM_BOT_TOKEN is required');
    }

    if (!this.config.telegram.chatId) {
      errors.push('TELEGRAM_CHAT_ID is required');
    }

    if (this.config.trading.riskLimits.maxRiskPerTradePercent <= 0 ||
        this.config.trading.riskLimits.maxRiskPerTradePercent > 100) {
      errors.push('MAX_RISK_PER_TRADE_PERCENT must be between 0 and 100');
    }

    if (this.config.trading.riskLimits.maxDailyLossPercent <= 0 ||
        this.config.trading.riskLimits.maxDailyLossPercent > 100) {
      errors.push('MAX_DAILY_LOSS_PERCENT must be between 0 and 100');
    }

    if (this.config.trading.riskLimits.maxTradesPerDay <= 0) {
      errors.push('MAX_TRADES_PER_DAY must be greater than 0');
    }

    if (!this.isValidTime(this.config.trading.autoSquareOffTime)) {
      errors.push('AUTO_SQUARE_OFF_TIME must be in HH:MM format');
    }

    if (!this.isValidTime(this.config.trading.marketStartTime)) {
      errors.push('MARKET_START_TIME must be in HH:MM format');
    }

    if (!this.isValidTime(this.config.trading.marketEndTime)) {
      errors.push('MARKET_END_TIME must be in HH:MM format');
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
  }

  private isValidTime(time: string): boolean {
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    return timeRegex.test(time);
  }

  public getConfig(): AppConfig {
    return { ...this.config };
  }

  public getTradingMode(): TradingMode {
    return this.config.trading.mode;
  }

  public isKillSwitchActive(): boolean {
    return this.config.trading.killSwitch;
  }

  public setKillSwitch(active: boolean): void {
    this.config.trading.killSwitch = active;
  }
}

export const configManager = new ConfigManager();
export default configManager;
