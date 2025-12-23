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
import { HeartbeatMonitor } from '../services/heartbeatMonitor';
import { OrderFillMonitor } from '../services/orderFillMonitor';
import { StopLossManager } from '../services/stopLossManager';
import { retry } from '../utils/retry';

export class TradingEngine extends EventEmitter {
  private config: AppConfig;
  private broker: IBroker;
  private riskManager: RiskManager;
  private positionManager: PositionManager;
  private scheduler: MarketScheduler;
  private telegramBot: TradingTelegramBot;
  private heartbeatMonitor: HeartbeatMonitor;
  private stopLossManager: StopLossManager;
  private strategies: Map<string, IStrategy> = new Map();
  private isRunning: boolean = false;
  private initialBalance: number = 0;
  private watchlist: string[] = [];

  // Slippage configuration (FIX #2)
  private readonly SLIPPAGE_BUFFER = 0.001; // 0.1% expected slippage

  constructor(config: AppConfig, watchlist?: string[]) {
    super();
    this.config = config;
    this.watchlist = watchlist || [];

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

    // FIX #4: Initialize heartbeat monitor
    this.heartbeatMonitor = new HeartbeatMonitor();

    // FIX #3: Initialize stop-loss manager
    this.stopLossManager = new StopLossManager(this.broker);

    this.setupEventHandlers();
  }

  private initializeBroker(): IBroker {
    if (this.config.trading.mode === TradingMode.PAPER) {
      logger.info('Initializing PAPER trading mode with REAL data');
      // Paper mode uses real Angel One data but sends Telegram signals instead of orders
      return new PaperBroker(
        1000000,                    // Initial balance
        this.config.broker,         // Angel One config for real data
        this.config.telegram,       // Telegram config for signals
        this.watchlist              // Watchlist for market data fetching
      );
    } else {
      logger.info('Initializing REAL trading mode');
      return new AngelOneBroker(this.config.broker, this.watchlist);
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
      // FIX #4: Record data receipt for heartbeat monitoring
      this.heartbeatMonitor.recordDataReceived();

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

    // FIX #4: Heartbeat monitor event handlers
    this.heartbeatMonitor.on('data_feed_dead', async (data: any) => {
      const timeoutMinutes = Math.floor(data.timeSinceData / 60000);

      await this.telegramBot.sendAlert(
        '💔 DATA FEED DEAD',
        `⚠️ No market data received for ${timeoutMinutes} minutes.\n\n` +
        `Bot may miss exit signals. Check connectivity.\n\n` +
        `Last data: ${new Date(Date.now() - data.timeSinceData).toLocaleTimeString('en-IN')}`
      );

      // If >5 minutes with no data, activate emergency shutdown
      if (data.timeSinceData > 300000) {
        logger.error('🚨 Data feed dead for 5+ minutes - triggering emergency shutdown');
        await this.activateEmergencyShutdown('Data feed dead for 5+ minutes');
      }
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

        // FIX #5: Add retry logic for getting LTP (critical operation)
        const currentPrice = await retry(
          () => this.broker.getLTP(signal.symbol),
          3, // Max 3 attempts
          500 // 500ms initial delay
        );

        if (!currentPrice) {
          logger.error('Failed to get current price after retries', { symbol: signal.symbol });
          await this.telegramBot.sendAlert(
            '❌ Price Fetch Failed',
            `Could not get price for ${signal.symbol} after 3 attempts. Signal aborted.`
          );
          return;
        }

        // FIX #2: Apply slippage buffer to expected entry price
        const adjustedEntryPrice = signal.action === 'BUY'
          ? currentPrice * (1 + this.SLIPPAGE_BUFFER)  // Expect to pay more on buy
          : currentPrice * (1 - this.SLIPPAGE_BUFFER); // Expect to receive less on sell

        logger.info('📊 Price and slippage calculation', {
          symbol: signal.symbol,
          action: signal.action,
          rawLTP: `₹${currentPrice.toFixed(2)}`,
          slippageBuffer: `${(this.SLIPPAGE_BUFFER * 100).toFixed(2)}%`,
          adjustedEntry: `₹${adjustedEntryPrice.toFixed(2)}`,
          slippageCost: `₹${Math.abs(adjustedEntryPrice - currentPrice).toFixed(2)}`
        });

        // Use adjusted price for stop-loss calculation
        const stopLoss = signal.stopLoss || (signal.action === 'BUY'
          ? adjustedEntryPrice * 0.995  // 0.5% from adjusted price for BUY
          : adjustedEntryPrice * 1.005); // 0.5% from adjusted price for SELL

        // Calculate quantity with ₹10,000 max capital requirement (after margin)
        let quantity = signal.quantity;
        if (!quantity) {
          const MAX_CAPITAL_REQUIRED = 10000; // Maximum capital required in INR (after margin)
          const marginMultiplier = signal.marginMultiplier || 5;

          // Calculate max quantity based on ₹10,000 capital limit
          // Required capital = (quantity × price) / marginMultiplier
          // So: quantity = (MAX_CAPITAL × marginMultiplier) / price
          const maxQuantityByCapital = Math.floor((MAX_CAPITAL_REQUIRED * marginMultiplier) / currentPrice);

          // Also calculate based on risk management
          const riskBasedQuantity = this.riskManager.calculatePositionSize(currentPrice, stopLoss);

          // Take the minimum to ensure we don't exceed either limit
          quantity = Math.min(maxQuantityByCapital, riskBasedQuantity);

          const orderValue = quantity * currentPrice;
          const requiredCapital = orderValue / marginMultiplier;

          logger.info('Quantity calculated', {
            symbol: signal.symbol,
            currentPrice: `₹${currentPrice.toFixed(2)}`,
            marginMultiplier,
            maxCapitalAllowed: `₹${MAX_CAPITAL_REQUIRED}`,
            maxQuantityByCapital,
            riskBasedQuantity,
            finalQuantity: quantity,
            orderValue: `₹${orderValue.toFixed(2)}`,
            requiredCapital: `₹${requiredCapital.toFixed(2)}`
          });
        }

        if (quantity === 0) {
          logger.warn('Calculated quantity is 0', { signal });
          return;
        }

        // CRITICAL FIX: Update risk manager with current balance BEFORE risk check
        // This ensures balance checking works correctly in both PAPER and REAL modes
        // FIX #5: Add retry for balance fetching
        const currentBalance = await retry(
          () => this.broker.getAccountBalance(),
          3,
          500
        );
        this.riskManager.updateBalance(currentBalance);

        // Use adjusted price for risk calculations
        const riskCheck = this.riskManager.checkOrderRisk(
          signal.symbol,
          signal.action === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
          quantity,
          adjustedEntryPrice, // Use adjusted price, not raw LTP
          stopLoss
        );

        if (!riskCheck.allowed) {
          logger.warn('Risk check failed', { signal, reason: riskCheck.reason });
          await this.telegramBot.sendAlert('Risk Check Failed', riskCheck.reason || 'Unknown reason');
          return;
        }

        // FIX #5: Add retry logic for order placement (critical operation)
        const order = await retry(
          () => this.broker.placeOrder(
            signal.symbol,
            signal.action === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
            OrderType.MARKET,
            quantity,
            undefined,
            stopLoss,
            signal.target
          ),
          3, // Retry up to 3 times
          1000 // 1 second delay
        );

        if (order) {
          logger.info('✅ Order placed successfully', {
            orderId: order.orderId,
            symbol: signal.symbol,
            side: order.side,
            quantity: order.quantity
          });

          // FIX #6: Wait for order fill confirmation before proceeding
          const fillMonitor = new OrderFillMonitor(this.broker);
          const fillResult = await fillMonitor.waitForFill(order.orderId, quantity);

          if (fillResult.status === 'FAILED' || fillResult.status === 'TIMEOUT') {
            logger.error('❌ Order did not fill', {
              orderId: order.orderId,
              status: fillResult.status
            });
            await this.telegramBot.sendAlert(
              '❌ Order Fill Failed',
              `Order ${order.orderId} for ${signal.symbol} did not fill.\n` +
              `Status: ${fillResult.status}`
            );
            return;
          }

          const filledQuantity = fillResult.filled;
          const fillPrice = fillResult.averagePrice || adjustedEntryPrice;

          if (fillResult.status === 'PARTIAL') {
            logger.warn('⚠️ Partial fill - adjusting quantity', {
              orderId: order.orderId,
              expected: quantity,
              filled: filledQuantity,
              percentFilled: `${((filledQuantity / quantity) * 100).toFixed(1)}%`
            });
            await this.telegramBot.sendAlert(
              '⚠️ Partial Fill',
              `Order ${order.orderId} for ${signal.symbol}\n` +
              `Expected: ${quantity}\n` +
              `Filled: ${filledQuantity} (${((filledQuantity / quantity) * 100).toFixed(1)}%)`
            );
          }

          // FIX #3: Place stop-loss immediately after fill (REAL mode only)
          if (this.config.trading.mode === TradingMode.REAL && filledQuantity > 0) {
            const position = this.positionManager.getPosition(signal.symbol);

            if (!position) {
              logger.error('❌ Position not found after fill - critical error', {
                symbol: signal.symbol,
                orderId: order.orderId
              });
              // Close the position immediately if we can't track it
              await this.closePosition(signal.symbol, 'Position tracking failed');
              return;
            }

            logger.info('📍 Attempting to place stop-loss protection...', {
              symbol: signal.symbol,
              stopLoss: `₹${stopLoss.toFixed(2)}`,
              target: signal.target ? `₹${signal.target.toFixed(2)}` : 'N/A'
            });

            const slPlaced = await this.stopLossManager.placeStopLoss(
              signal.symbol,
              order.orderId,
              position,
              stopLoss,
              signal.target
            );

            // FIX #3: CRITICAL - If SL placement fails, close position immediately
            if (!slPlaced) {
              logger.error('🚨 CRITICAL: Stop-loss placement FAILED - emergency close', {
                symbol: signal.symbol,
                orderId: order.orderId,
                reason: 'Cannot leave position unprotected'
              });

              await this.telegramBot.sendAlert(
                '🚨 CRITICAL: Emergency Position Close',
                `Failed to place stop-loss for ${signal.symbol}.\n\n` +
                `Position is being closed immediately for safety.\n\n` +
                `Order ID: ${order.orderId}`
              );

              // Emergency close
              await this.closePosition(signal.symbol, 'Stop-loss placement failed - emergency close');
              return;
            }

            logger.info('✅ Stop-loss protection placed successfully', {
              symbol: signal.symbol
            });
          }

          // Get current account balance and position count for telegram notification
          const balance = await this.broker.getAccountBalance();
          const positions = this.positionManager.getAllPositions();
          const openPositionCount = positions.length;

          await this.telegramBot.sendTradeNotification(
            signal.action,
            signal.symbol,
            filledQuantity, // Use actual filled quantity
            fillPrice, // Use actual fill price
            signal.reason,
            stopLoss,
            signal.target,
            balance,
            openPositionCount
          );

          logger.audit('SIGNAL_EXECUTED', {
            signal,
            order,
            filledQuantity,
            fillPrice,
            slippageExpected: this.SLIPPAGE_BUFFER * 100,
            stopLossPlaced: this.config.trading.mode === TradingMode.REAL
          });
        } else {
          logger.error('❌ Failed to place order after retries', { signal });
          await this.telegramBot.sendAlert(
            '❌ Order Failed',
            `Failed to place order for ${signal.symbol} after 3 attempts`
          );
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

    // Get fresh LTP before placing close order
    const currentPrice = await this.broker.getLTP(symbol) || position.currentPrice;

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
        currentPrice,
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
    // Update market prices BEFORE fetching positions/PnL to ensure fresh data
    await this.positionManager.updateMarketPrices();

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
    // Update market prices BEFORE fetching positions to ensure fresh data
    await this.positionManager.updateMarketPrices();

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

  /**
   * Emergency shutdown - closes all positions and stops trading immediately
   * Used when critical failures are detected (data feed dead, etc.)
   */
  public async activateEmergencyShutdown(reason: string): Promise<void> {
    logger.error('🚨 EMERGENCY SHUTDOWN ACTIVATED', { reason });

    // Activate kill switch to prevent new trades
    configManager.setKillSwitch(true);

    await this.telegramBot.sendAlert(
      '🚨 EMERGENCY SHUTDOWN',
      `**CRITICAL SITUATION DETECTED**\n\n` +
      `Reason: ${reason}\n\n` +
      `Actions taken:\n` +
      `✅ Kill switch activated\n` +
      `✅ All positions being closed\n` +
      `✅ Strategies stopped\n` +
      `✅ Data feeds stopped\n\n` +
      `Manual intervention required before restart.`
    );

    // Close all positions immediately
    await this.closeAllPositions(reason);

    // Stop accepting new signals
    await this.stopStrategies();

    // Stop data feeds
    if (this.config.trading.mode === TradingMode.PAPER) {
      (this.broker as any).stopMarketDataFetching?.();
    }

    // Stop monitoring services
    this.heartbeatMonitor.stop();
    this.stopLossManager.stopMonitoring();

    logger.info('✅ Emergency shutdown complete');
    logger.audit('EMERGENCY_SHUTDOWN', { reason });
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

    // FIX #4: Start heartbeat monitoring
    this.heartbeatMonitor.start();

    // FIX #3: Start stop-loss monitoring (REAL mode only)
    if (this.config.trading.mode === TradingMode.REAL) {
      this.stopLossManager.startMonitoring();
      logger.info('✅ Stop-loss manager monitoring started');
    }

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

    // FIX #4: Stop heartbeat monitoring
    this.heartbeatMonitor.stop();

    // FIX #3: Stop stop-loss monitoring and cancel all pending SL orders
    if (this.config.trading.mode === TradingMode.REAL) {
      this.stopLossManager.stopMonitoring();
      await this.stopLossManager.cancelAllStopLosses('Engine shutdown');
      logger.info('✅ Stop-loss manager stopped and all SL orders cancelled');
    }

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
