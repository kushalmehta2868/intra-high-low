import { EventEmitter } from 'events';
import { IBroker } from '../brokers/base';
import { AngelOneBroker } from '../brokers/angelone/broker';
import { PaperBroker } from '../brokers/paper/broker';
import { RiskManager } from '../risk/riskManager';
import { PositionManager } from './positionManager';
import { MarketScheduler } from './scheduler';
import { IStrategy } from '../strategies/base';
import { TradingTelegramBot } from '../telegram/bot';
import { AppConfig, TradingMode, StrategySignal, OrderSide, OrderType, Position, Order } from '../types';
import { logger } from '../utils/logger';
import configManager from '../config';
import { positionLockManager } from '../utils/positionLock';

export class TradingEngine extends EventEmitter {
  private config: AppConfig;
  private broker: IBroker;
  private riskManager: RiskManager;
  private positionManager: PositionManager;
  private scheduler: MarketScheduler;
  private telegramBot: TradingTelegramBot;
  private strategies: Map<string, IStrategy> = new Map();
  private isRunning: boolean = false;
  private initialBalance: number = 0;

  constructor(config: AppConfig) {
    super();
    this.config = config;

    this.broker = this.initializeBroker();
    this.initialBalance = 1000000;
    this.riskManager = new RiskManager(config.trading.riskLimits, this.initialBalance);
    this.positionManager = new PositionManager(this.broker);
    this.scheduler = new MarketScheduler(
      config.trading.marketStartTime,
      config.trading.marketEndTime,
      config.trading.autoSquareOffTime
    );
    this.telegramBot = new TradingTelegramBot(config.telegram);

    this.setupEventHandlers();
  }

  private initializeBroker(): IBroker {
    if (this.config.trading.mode === TradingMode.PAPER) {
      logger.info('Initializing PAPER trading mode with REAL data');
      // Paper mode uses real Angel One data but sends Telegram signals instead of orders
      return new PaperBroker(
        1000000,                    // Initial balance
        this.config.broker,         // Angel One config for real data
        this.config.telegram        // Telegram config for signals
      );
    } else {
      logger.info('Initializing REAL trading mode');
      return new AngelOneBroker(this.config.broker);
    }
  }

  private setupEventHandlers(): void {
    this.broker.on('order_update', (order: Order) => {
      logger.info('Order update received', order);
      logger.audit('ORDER_UPDATE', order);
    });

    this.broker.on('error', (error: Error) => {
      logger.error('Broker error', error);
      this.telegramBot.sendAlert('Broker Error', error.message);
    });

    // Forward market data to all strategies
    this.broker.on('market_data', (data: any) => {
      logger.info(`🔄 Feeding data to strategy: ${data.symbol}`, {
        ltp: `₹${data.ltp.toFixed(2)}`,
        high: `₹${data.high.toFixed(2)}`,
        low: `₹${data.low.toFixed(2)}`
      });

      // Feed data to all active strategies
      for (const strategy of this.strategies.values()) {
        strategy.onMarketData(data);
      }
    });

    this.positionManager.on('position_opened', (position: Position) => {
      logger.info('Position opened', position);
      this.telegramBot.sendPositionUpdate(position.symbol, 0, 0, 'OPENED');
    });

    this.positionManager.on('position_closed', (position: any) => {
      logger.info('Position closed', position);
      this.riskManager.recordTrade(position.pnl);
      this.telegramBot.sendPositionUpdate(
        position.symbol,
        position.pnl,
        (position.pnl / (position.entryPrice * position.quantity)) * 100,
        'CLOSED'
      );
    });

    this.positionManager.on('stop_loss_triggered', async (position: Position) => {
      logger.warn('Stop loss triggered', position);
      await this.telegramBot.sendAlert(
        'Stop Loss Triggered',
        `Symbol: ${position.symbol}\nPrice: ₹${position.currentPrice.toFixed(2)}`
      );
      await this.closePosition(position.symbol, 'Stop loss triggered');
    });

    this.positionManager.on('target_reached', async (position: Position) => {
      logger.info('Target reached', position);
      await this.telegramBot.sendAlert(
        'Target Reached',
        `Symbol: ${position.symbol}\nPrice: ₹${position.currentPrice.toFixed(2)}`
      );
      await this.closePosition(position.symbol, 'Target reached');
    });

    this.riskManager.on('daily_loss_limit_reached', async (data: any) => {
      logger.error('Daily loss limit reached', data);
      await this.telegramBot.sendRiskAlert(
        'Daily Loss Limit Reached',
        `Daily P&L: ₹${data.dailyPnL.toFixed(2)}\nLimit: ₹${data.limit.toFixed(2)}\n\nAll positions will be closed.`
      );
      await this.closeAllPositions('Daily loss limit reached');
      configManager.setKillSwitch(true);
    });

    this.riskManager.on('approaching_daily_loss_limit', async (data: any) => {
      await this.telegramBot.sendRiskAlert(
        'Approaching Daily Loss Limit',
        `Daily P&L: ₹${data.dailyPnL.toFixed(2)}\nPercentage: ${data.percentage.toFixed(2)}%\nLimit: ${data.limit.toFixed(2)}`
      );
    });

    this.scheduler.on('market_open', async () => {
      logger.info('🟢 Market opened - starting strategies and market data');

      // Start market data fetching (Paper mode only)
      if (this.config.trading.mode === TradingMode.PAPER) {
        await (this.broker as any).startMarketDataFetching?.();
      }

      await this.startStrategies();
    });

    this.scheduler.on('market_close', async () => {
      logger.info('🔴 Market closed - stopping strategies and market data');

      await this.stopStrategies();

      // Stop market data fetching (Paper mode only)
      if (this.config.trading.mode === TradingMode.PAPER) {
        (this.broker as any).stopMarketDataFetching?.();
      }
    });

    this.scheduler.on('auto_square_off', async () => {
      logger.info('Auto square-off triggered');
      await this.telegramBot.sendAlert('Auto Square-Off', 'Closing all open positions');
      await this.closeAllPositions('Auto square-off');
    });

    this.scheduler.on('update_prices', async () => {
      await this.positionManager.updateMarketPrices();
    });

    // NOTE: Telegram command handlers disabled (notification-only mode)
    // Commands like /status, /positions, etc. are not available
    // The bot only sends notifications and alerts
  }

  public addStrategy(strategy: IStrategy): void {
    strategy.on('signal', async (signal: StrategySignal) => {
      await this.handleStrategySignal(signal);
    });

    strategy.on('error', (error: Error) => {
      logger.error(`Strategy error: ${strategy.getName()}`, error);
    });

    this.strategies.set(strategy.getName(), strategy);
    logger.info('Strategy added', { name: strategy.getName() });
  }

  private async handleStrategySignal(signal: StrategySignal): Promise<void> {
    if (configManager.isKillSwitchActive()) {
      logger.warn('Signal ignored - kill switch active', signal);
      return;
    }

    if (!this.scheduler.isMarketHours()) {
      logger.warn('Signal ignored - outside market hours', signal);
      return;
    }

    if (this.scheduler.isAfterSquareOffTime()) {
      logger.warn('Signal ignored - after square-off time', signal);
      return;
    }

    logger.info('Processing strategy signal', signal);

    // Use position lock to prevent race conditions
    const result = await positionLockManager.withLock(signal.symbol, async () => {
      try {
        if (signal.action === 'CLOSE') {
          await this.closePosition(signal.symbol, signal.reason);
          return;
        }

        const currentPrice = await this.broker.getLTP(signal.symbol);
        if (!currentPrice) {
          logger.error('Failed to get current price', { symbol: signal.symbol });
          return;
        }

        const stopLoss = signal.stopLoss || currentPrice * 0.98;
        const quantity = signal.quantity || this.riskManager.calculatePositionSize(currentPrice, stopLoss);

        if (quantity === 0) {
          logger.warn('Calculated quantity is 0', { signal });
          return;
        }

        const riskCheck = this.riskManager.checkOrderRisk(
          signal.symbol,
          signal.action === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
          quantity,
          currentPrice,
          stopLoss
        );

        if (!riskCheck.allowed) {
          logger.warn('Risk check failed', { signal, reason: riskCheck.reason });
          await this.telegramBot.sendAlert('Risk Check Failed', riskCheck.reason || 'Unknown reason');
          return;
        }

        const order = await this.broker.placeOrder(
          signal.symbol,
          signal.action === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
          OrderType.MARKET,
          quantity,
          undefined,
          stopLoss
        );

        if (order) {
          await this.telegramBot.sendTradeNotification(
            signal.action,
            signal.symbol,
            quantity,
            currentPrice,
            signal.reason
          );

          logger.audit('SIGNAL_EXECUTED', { signal, order });
        } else {
          logger.error('Failed to place order', { signal });
          await this.telegramBot.sendAlert('Order Failed', `Failed to place order for ${signal.symbol}`);
        }
      } catch (error: any) {
        logger.error('Error handling strategy signal', error);
        await this.telegramBot.sendAlert('Signal Execution Error', error.message);
      }
    });

    if (result === null) {
      logger.warn('Signal processing skipped - position lock could not be acquired', { signal });
      await this.telegramBot.sendAlert(
        'Signal Skipped',
        `Could not process signal for ${signal.symbol} - position is being modified by another operation`
      );
    }
  }

  private async closePosition(symbol: string, reason: string): Promise<void> {
    // Note: This is called within withLock, so no need to re-acquire lock
    const position = this.positionManager.getPosition(symbol);
    if (!position) {
      logger.warn('No position to close', { symbol });
      return;
    }

    const side = position.type === 'LONG' ? OrderSide.SELL : OrderSide.BUY;

    const order = await this.broker.placeOrder(
      symbol,
      side,
      OrderType.MARKET,
      position.quantity
    );

    if (order) {
      logger.info('Position close order placed', { symbol, reason });
      await this.telegramBot.sendTradeNotification(
        side,
        symbol,
        position.quantity,
        position.currentPrice,
        reason
      );
    }
  }

  private async closeAllPositions(reason: string): Promise<void> {
    const positions = this.positionManager.getAllPositions();

    logger.info('Closing all positions', { count: positions.length, reason });

    for (const position of positions) {
      await this.closePosition(position.symbol, reason);
    }
  }

  private async startStrategies(): Promise<void> {
    for (const strategy of this.strategies.values()) {
      await strategy.initialize();
      logger.info('Strategy started', { name: strategy.getName() });
    }
  }

  private async stopStrategies(): Promise<void> {
    for (const strategy of this.strategies.values()) {
      await strategy.shutdown();
      logger.info('Strategy stopped', { name: strategy.getName() });
    }
  }

  private async sendStatusReport(): Promise<void> {
    const balance = await this.broker.getAccountBalance();
    const positions = this.positionManager.getAllPositions();
    const totalPnL = this.positionManager.getTotalPnL();

    await this.telegramBot.sendStatusReport({
      mode: this.config.trading.mode,
      killSwitch: configManager.isKillSwitchActive(),
      positionCount: positions.length,
      balance: balance,
      totalPnL: totalPnL
    });
  }

  private async sendPositionsReport(): Promise<void> {
    const positions = this.positionManager.getAllPositions();
    await this.telegramBot.sendPositionsReport(positions);
  }

  private async sendPnLReport(): Promise<void> {
    const balance = await this.broker.getAccountBalance();
    const stats = this.riskManager.getRiskStats();

    await this.telegramBot.sendPnLReport({
      total: balance - this.initialBalance,
      startingBalance: this.initialBalance,
      currentBalance: balance,
      returnPercent: ((balance - this.initialBalance) / this.initialBalance) * 100,
      dailyPnL: stats.dailyPnL,
      tradesExecutedToday: stats.tradesExecutedToday
    });
  }

  private async sendRiskStatsReport(): Promise<void> {
    const stats = this.riskManager.getRiskStats();
    await this.telegramBot.sendRiskStatsReport(stats);
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Trading engine already running');
      return;
    }

    logger.info('Starting trading engine', {
      mode: this.config.trading.mode,
      killSwitch: configManager.isKillSwitchActive()
    });

    const connected = await this.broker.connect();
    if (!connected) {
      throw new Error('Failed to connect to broker');
    }

    this.initialBalance = await this.broker.getAccountBalance();
    this.riskManager.resetStartingBalance(this.initialBalance);

    await this.positionManager.syncPositions();

    this.scheduler.start();
    this.telegramBot.start();

    this.isRunning = true;

    // If starting during market hours, start market data fetching immediately
    if (this.scheduler.isMarketHours() && this.config.trading.mode === TradingMode.PAPER) {
      logger.info('⏰ Bot started during market hours - starting market data fetching immediately');
      await (this.broker as any).startMarketDataFetching?.();
      await this.startStrategies();
    } else {
      logger.info('⏰ Bot started outside market hours - will wait for market open');
    }

    await this.telegramBot.sendMessage(
      `🚀 *Trading Engine Started*\n\nMode: ${this.config.trading.mode}\nBalance: ₹${this.initialBalance.toFixed(2)}\n\n` +
      (this.scheduler.isMarketHours()
        ? '🟢 Market is OPEN - trading active'
        : '🔴 Market is CLOSED - waiting for market open')
    );

    logger.info('Trading engine started successfully');
    logger.audit('TRADING_ENGINE_STARTED', {
      mode: this.config.trading.mode,
      balance: this.initialBalance
    });
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Trading engine not running');
      return;
    }

    logger.info('Stopping trading engine');

    await this.stopStrategies();
    await this.closeAllPositions('Engine shutdown');

    // Release all position locks
    positionLockManager.releaseAllLocks();

    this.scheduler.stop();
    await this.telegramBot.stop();
    await this.broker.disconnect();

    this.isRunning = false;

    logger.info('Trading engine stopped');
    logger.audit('TRADING_ENGINE_STOPPED', {});
  }
}
