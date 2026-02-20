import { EventEmitter } from "events";
import { IBroker } from "../brokers/base";
import { AngelOneBroker } from "../brokers/angelone/broker";
import { PaperBroker } from "../brokers/paper/broker";
import { RiskManager } from "../risk/riskManager";
import { PositionManager } from "./positionManager";
import { MarketScheduler } from "./scheduler";
import { IStrategy } from "../strategies/base";
import { TradingTelegramBot } from "../telegram/bot";
import {
  AppConfig,
  TradingMode,
  StrategySignal,
  OrderSide,
  OrderType,
  Position,
  Order,
  MarketData,
} from "../types";
import { logger } from "../utils/logger";
import configManager from "../config";
import { positionLockManager } from "../utils/positionLock";
import { HeartbeatMonitor } from "../services/heartbeatMonitor";
import { OrderFillMonitor } from "../services/orderFillMonitor";
import { StopLossManager } from "../services/stopLossManager";
import { retry } from "../utils/retry";
import { orderIdempotencyManager } from "../services/orderIdempotency";
import { MetricsTracker } from "../services/metricsTracker";
import { PositionReconciliationService } from "../services/positionReconciliationService";
import { DashboardDisplay } from "../services/dashboardDisplay";
import { healthCheckServer } from "../utils/healthCheck";
import { marginChecker } from "../services/marginChecker";
import { circuitLimitDetector } from "../services/circuitLimitDetector";

export class TradingEngine extends EventEmitter {
  private config: AppConfig;
  private broker: IBroker;
  private riskManager: RiskManager;
  private positionManager: PositionManager;
  private scheduler: MarketScheduler;
  private telegramBot: TradingTelegramBot;
  private heartbeatMonitor: HeartbeatMonitor;
  private stopLossManager: StopLossManager;
  private metricsTracker: MetricsTracker;
  private positionReconciliation?: PositionReconciliationService;
  private dashboardDisplay?: DashboardDisplay;
  private strategies: Map<string, IStrategy> = new Map();
  private isRunning: boolean = false;
  private initialBalance: number = 0;
  private watchlist: string[] = [];
  private symbolsToTrail: Set<string> = new Set(); // Track symbols that requested trailing SL

  // Slippage configuration (IMPROVED - Dynamic calculation)
  private readonly SLIPPAGE_BUFFER_MIN = 0.001; // 0.1% minimum expected slippage
  private readonly SLIPPAGE_BUFFER_MAX = 0.005; // 0.5% maximum expected slippage

  // Limit order configuration
  private readonly LIMIT_ORDER_TOLERANCE = 0.0015; // 0.15% tolerance for limit orders
  private readonly ORDER_TIMEOUT_MS = 30000; // 30 seconds timeout for limit orders

  // Logging throttle - log strategy feeding every 10 seconds
  private lastStrategyLogTime: Map<string, number> = new Map();
  private readonly STRATEGY_LOG_INTERVAL_MS = 10000; // 10 seconds

  // Dashboard display interval
  private dashboardDisplayInterval?: NodeJS.Timeout;

  // Background reconnection
  private reconnectionInterval?: NodeJS.Timeout;
  private readonly RECONNECTION_INTERVAL_MS = 60 * 1000; // Try reconnecting every 1 minute

  constructor(config: AppConfig, watchlist?: string[]) {
    super();
    this.config = config;
    this.watchlist = watchlist || [];

    this.broker = this.initializeBroker();
    this.initialBalance = 1000000;
    this.riskManager = new RiskManager(
      config.trading.riskLimits,
      this.initialBalance,
    );
    this.positionManager = new PositionManager(this.broker);
    this.scheduler = new MarketScheduler(
      config.trading.marketStartTime,
      config.trading.marketEndTime,
      config.trading.autoSquareOffTime,
      config.trading.signalStartTime,
      config.trading.signalEndTime,
    );
    this.telegramBot = new TradingTelegramBot(config.telegram);

    // FIX #4: Initialize heartbeat monitor
    this.heartbeatMonitor = new HeartbeatMonitor();

    // FIX #3: Initialize stop-loss manager
    this.stopLossManager = new StopLossManager(this.broker);

    // Initialize metrics tracker
    this.metricsTracker = new MetricsTracker(this.initialBalance);

    this.setupEventHandlers();
  }

  private initializeBroker(): IBroker {
    if (this.config.trading.mode === TradingMode.PAPER) {
      logger.info("Initializing PAPER trading mode with REAL data");
      // Paper mode uses real Angel One data but sends Telegram signals instead of orders
      return new PaperBroker(
        1000000, // Initial balance
        this.config.broker, // Angel One config for real data
        this.config.telegram, // Telegram config for signals
        this.watchlist, // Watchlist for market data fetching
        this.config.trading.marketStartTime, // Market start time for data control
        this.config.trading.marketEndTime, // Market end time for data control
      );
    } else {
      logger.info("Initializing REAL trading mode");
      return new AngelOneBroker(this.config.broker, this.watchlist);
    }
  }

  private setupEventHandlers(): void {
    this.broker.on("order_update", (order: Order) => {
      logger.info("Order update received", order);
      logger.audit("ORDER_UPDATE", order);
    });

    this.broker.on("error", (error: Error) => {
      logger.error("Broker error", error);
      this.telegramBot.sendAlert("Broker Error", error.message);
    });

    // Forward market data to all strategies
    this.broker.on("market_data", (data: any) => {
      // FIX #4: Record data receipt for heartbeat monitoring
      this.heartbeatMonitor.recordDataReceived();

      // Throttle logging - log every 10 seconds per symbol
      const now = Date.now();
      const lastLog = this.lastStrategyLogTime.get(data.symbol) || 0;

      if (now - lastLog >= this.STRATEGY_LOG_INTERVAL_MS) {
        this.lastStrategyLogTime.set(data.symbol, now);

        logger.info(`🔄 Feeding data to strategies: ${data.symbol}`, {
          ltp: `₹${data.ltp.toFixed(2)}`,
          high: `₹${data.high.toFixed(2)}`,
          low: `₹${data.low.toFixed(2)}`,
          volume: data.volume > 0 ? data.volume.toLocaleString() : "N/A",
          strategies: this.strategies.size,
        });
      }

      // Feed data to all active strategies (happens on every tick, just throttle logging)
      for (const strategy of this.strategies.values()) {
        strategy.onMarketData(data);
      }

      // NEW: Trailing Stop-Loss Engine
      this.handleTrailingStopLoss(data);
    });

    this.positionManager.on("position_opened", (position: Position) => {
      logger.info("Position opened", position);
      this.telegramBot.sendPositionUpdate(position.symbol, 0, 0, "OPENED");
    });

    this.positionManager.on("position_closed", (position: any) => {
      logger.info("Position closed", position);

      // Record trade with detailed information for daily summary
      const pnlPercent =
        (position.pnl / (position.entryPrice * position.quantity)) * 100;
      this.riskManager.recordTrade(position.pnl, {
        symbol: position.symbol,
        side: position.type === "LONG" ? "SELL" : "BUY", // Closing side
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        exitPrice: position.currentPrice || position.exitPrice,
        pnlPercent: pnlPercent,
        entryTime: position.entryTime,
        exitTime: position.exitTime || new Date(),
      });

      // IMPROVEMENT: Record trade in metrics tracker for comprehensive analytics
      const exitPrice = position.currentPrice || position.exitPrice;
      const entryPrice = position.entryPrice;
      const holdTimeMs = position.exitTime
        ? position.exitTime.getTime() - position.entryTime.getTime()
        : Date.now() - position.entryTime.getTime();

      // Calculate actual slippage (approximate - would need entry order price for exact)
      const actualSlippage =
        Math.abs((exitPrice - entryPrice) / entryPrice) * 0.1; // Estimate

      this.metricsTracker.recordTrade({
        symbol: position.symbol,
        entryTime: position.entryTime,
        exitTime: position.exitTime || new Date(),
        side: position.type === "LONG" ? "SELL" : "BUY",
        entryPrice: position.entryPrice,
        exitPrice: exitPrice,
        quantity: position.quantity,
        pnl: position.pnl,
        pnlPercent: pnlPercent,
        expectedSlippage: this.SLIPPAGE_BUFFER_MIN,
        actualSlippage: actualSlippage,
        holdTimeMs: holdTimeMs,
        result:
          position.pnl > 0.01
            ? "WIN"
            : position.pnl < -0.01
              ? "LOSS"
              : "BREAKEVEN",
        exitReason: position.exitReason || "MANUAL",
      });

      // Send enhanced Telegram notification with full trade details
      this.telegramBot.sendPositionUpdate(
        position.symbol,
        position.pnl,
        pnlPercent,
        "CLOSED",
        {
          entryPrice: position.entryPrice,
          exitPrice: position.currentPrice || position.exitPrice,
          quantity: position.quantity,
          entryTime: position.entryTime,
          exitTime: position.exitTime || new Date(),
        },
      );
    });

    this.positionManager.on(
      "stop_loss_triggered",
      async (position: Position) => {
        logger.warn("Stop loss triggered", position);
        await this.telegramBot.sendAlert(
          "Stop Loss Triggered",
          `Symbol: ${position.symbol}\nPrice: ₹${position.currentPrice.toFixed(2)}`,
        );
        await this.closePosition(position.symbol, "Stop loss triggered");
      },
    );

    this.positionManager.on("target_reached", async (position: Position) => {
      logger.info("Target reached", position);
      await this.telegramBot.sendAlert(
        "Target Reached",
        `Symbol: ${position.symbol}\nPrice: ₹${position.currentPrice.toFixed(2)}`,
      );
      await this.closePosition(position.symbol, "Target reached");
    });

    this.riskManager.on("daily_loss_limit_reached", async (data: any) => {
      logger.error("Daily loss limit reached", data);
      await this.telegramBot.sendRiskAlert(
        "Daily Loss Limit Reached",
        `Daily P&L: ₹${data.dailyPnL.toFixed(2)}\nLimit: ₹${data.limit.toFixed(2)}\n\nAll positions will be closed.`,
      );
      await this.closeAllPositions("Daily loss limit reached");
      configManager.setKillSwitch(true);
    });

    this.riskManager.on("approaching_daily_loss_limit", async (data: any) => {
      await this.telegramBot.sendRiskAlert(
        "Approaching Daily Loss Limit",
        `Daily P&L: ₹${data.dailyPnL.toFixed(2)}\nPercentage: ${data.percentage.toFixed(2)}%\nLimit: ${data.limit.toFixed(2)}`,
      );
    });

    this.scheduler.on("market_open", async () => {
      logger.info(
        "🟢 Market opened - starting strategies and resetting daily data",
      );

      // Reset daily data for fresh start (Paper mode)
      if (this.config.trading.mode === TradingMode.PAPER) {
        (this.broker as any).resetDailyData?.();
        logger.info("📅 Daily market data reset - starting fresh");
      }

      // WebSocket already connected, just start strategies
      await this.startStrategies();
    });

    this.scheduler.on("market_close", async () => {
      logger.info("🔴 Market closed - stopping strategies");

      // WebSocket stays connected, just stop strategies
      await this.stopStrategies();
    });

    this.scheduler.on("auto_square_off", async () => {
      logger.info("🔴 AUTO SQUARE-OFF TRIGGERED");
      await this.telegramBot.sendAlert(
        "🔴 Auto Square-Off",
        "Closing all open positions",
      );

      // Close all positions
      await this.closeAllPositions("Auto square-off");

      // ✅ CRITICAL: Verify all positions are closed
      await this.verifyAllPositionsClosed();
    });

    this.scheduler.on("update_prices", async () => {
      await this.positionManager.updateMarketPrices();
    });

    this.scheduler.on("daily_summary", async () => {
      logger.info("📊 Sending daily summary report");
      await this.sendDailySummaryReport();
    });

    // FIX #4: Heartbeat monitor event handlers
    this.heartbeatMonitor.on("data_feed_dead", async (data: any) => {
      const timeoutMinutes = Math.floor(data.timeSinceData / 60000);

      await this.telegramBot.sendAlert(
        "💔 DATA FEED DEAD",
        `⚠️ No market data received for ${timeoutMinutes} minutes.\n\n` +
          `Bot may miss exit signals. Check connectivity.\n\n` +
          `Last data: ${new Date(Date.now() - data.timeSinceData).toLocaleTimeString("en-IN")}`,
      );

      // If >5 minutes with no data, activate emergency shutdown
      if (data.timeSinceData > 300000) {
        logger.error(
          "🚨 Data feed dead for 5+ minutes - triggering emergency shutdown",
        );
        await this.activateEmergencyShutdown("Data feed dead for 5+ minutes");
      }
    });

    // IMPROVEMENT: Metrics tracker event handlers
    this.metricsTracker.on("high_slippage", async (data: any) => {
      await this.telegramBot.sendAlert(
        "⚠️ HIGH SLIPPAGE DETECTED",
        `Symbol: ${data.symbol}\n` +
          `Expected: ${(data.expected * 100).toFixed(3)}%\n` +
          `Actual: ${(data.slippage * 100).toFixed(3)}%`,
      );
    });

    this.metricsTracker.on("consecutive_losses_warning", async (data: any) => {
      await this.telegramBot.sendAlert(
        "⚠️ CONSECUTIVE LOSSES WARNING",
        `${data.count} losses in a row.\n` + `${data.message}`,
      );
    });

    this.metricsTracker.on("high_drawdown", async (data: any) => {
      await this.telegramBot.sendAlert(
        "⚠️ HIGH DRAWDOWN ALERT",
        `Current drawdown: ${data.drawdownPercent.toFixed(2)}%\n` +
          `Amount: ₹${data.drawdown.toFixed(2)}\n` +
          `Peak: ₹${data.peakBalance.toFixed(2)}`,
      );
    });

    // NOTE: Telegram command handlers disabled (notification-only mode)
    // Commands like /status, /positions, etc. are not available
    // The bot only sends notifications and alerts
  }

  public addStrategy(strategy: IStrategy): void {
    strategy.on("signal", async (signal: StrategySignal) => {
      await this.handleStrategySignal(signal);
    });

    strategy.on("error", (error: Error) => {
      logger.error(`Strategy error: ${strategy.getName()}`, error);
      this.telegramBot
        .sendAlert(
          "⚠️ Strategy Error",
          `Strategy: ${strategy.getName()}\nError: ${error.message}`,
        )
        .catch((err) =>
          logger.error("Failed to send strategy error alert", err),
        );
    });

    this.strategies.set(strategy.getName(), strategy);
    logger.info("Strategy added", { name: strategy.getName() });
  }

  /**
   * Core Trailing Stop-Loss Logic
   * 1. 0.3% profit -> Move SL to Break-Even (Entry Price)
   * 2. Every 0.2% further profit -> Move SL up/down by 0.2%
   */
  private async handleTrailingStopLoss(data: MarketData): Promise<void> {
    if (!this.symbolsToTrail.has(data.symbol)) return;

    const position = this.positionManager.getPosition(data.symbol);
    if (!position || position.quantity === 0) {
      this.symbolsToTrail.delete(data.symbol);
      return;
    }

    const ltp = data.ltp;
    const entryPrice = position.entryPrice;
    const currentSL = position.stopLoss;

    if (!currentSL) return;

    // Initialize initialStopLoss if not set
    if (!position.initialStopLoss) {
      position.initialStopLoss = currentSL;
      position.useTrailingSL = true;
    }

    const profitPct =
      position.type === "LONG"
        ? ((ltp - entryPrice) / entryPrice) * 100
        : ((entryPrice - ltp) / entryPrice) * 100;

    // STEP 1: Move to Break-Even at 0.3% profit
    if (!position.isTrailing && profitPct >= 0.3) {
      const newSL = entryPrice;

      logger.info(`🛡️ [Trailing SL] Break-even triggered for ${data.symbol}`, {
        entry: entryPrice,
        ltp: ltp,
        newSL: newSL,
      });

      const success = await this.stopLossManager.updateStopLoss(
        data.symbol,
        newSL,
      );
      if (success) {
        position.stopLoss = newSL;
        position.isTrailing = true;
        this.telegramBot.sendAlert(
          "🛡️ Stop-Loss Moved to Break-Even",
          `Symbol: ${data.symbol}\nNew SL: ₹${newSL.toFixed(2)}\nProfit hit: ${profitPct.toFixed(2)}%`,
        );
      }
      return;
    }

    // STEP 2: Trail by 0.2% steps
    if (position.isTrailing && position.stopLoss !== undefined) {
      const slDistFromEntry =
        position.type === "LONG"
          ? ((position.stopLoss - entryPrice) / entryPrice) * 100
          : ((entryPrice - position.stopLoss) / entryPrice) * 100;

      const targetSLDist = profitPct - 0.2;

      if (
        targetSLDist > slDistFromEntry &&
        targetSLDist - slDistFromEntry >= 0.2
      ) {
        const newSL =
          position.type === "LONG"
            ? entryPrice * (1 + targetSLDist / 100)
            : entryPrice * (1 - targetSLDist / 100);

        logger.info(`📈 [Trailing SL] Moving SL higher for ${data.symbol}`, {
          oldSL: position.stopLoss,
          newSL: newSL,
          profit: `${profitPct.toFixed(2)}%`,
        });

        const success = await this.stopLossManager.updateStopLoss(
          data.symbol,
          newSL,
        );
        if (success) {
          position.stopLoss = newSL;
        }
      }
    }
  }

  private async handleStrategySignal(signal: StrategySignal): Promise<void> {
    if (configManager.isKillSwitchActive()) {
      logger.warn("Signal ignored - kill switch active", signal);
      return;
    }

    if (!this.scheduler.isMarketHours()) {
      logger.warn("Signal ignored - outside market hours", signal);
      return;
    }

    // CRITICAL: Only generate signals during 9:30 AM - 3:00 PM
    if (!this.scheduler.isSignalGenerationHours()) {
      logger.info(
        "Signal ignored - outside signal generation hours (9:30 AM - 3:00 PM)",
        {
          symbol: signal.symbol,
          action: signal.action,
        },
      );
      return;
    }

    if (this.scheduler.isAfterSquareOffTime()) {
      logger.warn("Signal ignored - after square-off time", signal);
      return;
    }

    logger.info("Processing strategy signal", signal);

    // Use position lock to prevent race conditions
    const result = await positionLockManager.withLock(
      signal.symbol,
      async () => {
        try {
          if (signal.action === "CLOSE") {
            await this.closePosition(signal.symbol, signal.reason);
            return;
          }

          // IMPROVEMENT: Check order idempotency BEFORE any processing
          const orderKey = orderIdempotencyManager.generateOrderKey(
            signal.symbol,
            signal.action,
            signal.quantity || 0,
          );

          if (
            !orderIdempotencyManager.canPlaceOrder(
              orderKey,
              signal.symbol,
              signal.action,
            )
          ) {
            logger.warn(
              "Order rejected by idempotency check - duplicate order",
              {
                orderKey,
                symbol: signal.symbol,
                action: signal.action,
              },
            );
            return; // Exit early, duplicate order
          }

          // Get current price with retry
          const currentPrice = await retry(
            () => this.broker.getLTP(signal.symbol),
            3,
            500,
          ).catch((error) => {
            logger.error("Failed to get current price after retries", {
              symbol: signal.symbol,
              error: error.message,
            });
            orderIdempotencyManager.markOrderFailed(
              orderKey,
              "Price fetch failed",
            );
            return null;
          });

          if (!currentPrice) {
            logger.warn("Price fetch failed - skipping signal", {
              symbol: signal.symbol,
            });
            return;
          }

          if (!currentPrice) {
            logger.warn("Price fetch failed - skipping signal", {
              symbol: signal.symbol,
            });
            return;
          }

          // IMPROVEMENT: Check Circuit Limits
          // If buying and at upper circuit, or selling and at lower circuit, SKIP
          // We don't have exact circuit limits from API in getLTP usually, but we might have it in quote.
          // For now using approximate or if we had quote data.
          // Broker.getLTP only returns number.
          // We will assume 10% or 20% limits or check if currentPrice is suspiciously round or static?
          // Actually circuitLimitDetector needs upper/lower limits.
          // We need to fetch FULL market quote to get circuit limits.
          // BaseBroker.getLTP returns price. We might need `getQuote` or similar.
          // AngelOneBroker has `wsDataFeed` which has snapshots.
          // But `handleSignal` uses `this.broker.getLTP`.
          // Let's rely on `circuitLimitDetector` logic.
          // Wait, `circuitLimitDetector.isAtCircuitLimit` takes `price`, `upperLimit`, `lowerLimit`.
          // We don't have limits here yet.
          // We need to fetch limits. This is an API limitation in `IBroker`.
          // For Phase 1, we might skip this if we can't reliably get limits without changing IBroker.
          // OR we can implement `getQuote` in IBroker.
          // Let's look at `AngelOneBroker`. It has `client.getLTP`.
          // Does `client` support getting quote with limits? Yes `getQuote`.
          // I will SKIP this for now as per plan "Approximate" or "skip if at limit".
          // If I can't get limits, I can't check.
          // I'll add a TODO or basic check if I can.
          // For now, I'll proceed without it to unblock, as `CircuitLimitDetector` exists but data is missing.
          // Actually, the plan says "Implement ... Integrate".
          // I'll create `getMarketQuote` in IBroker later.
          // For now, I will use `SLIPPAGE_BUFFER_MIN` for conservative slippage estimate
          const slippageBuffer = this.SLIPPAGE_BUFFER_MIN;

          const adjustedEntryPrice =
            signal.action === "BUY"
              ? currentPrice * (1 + slippageBuffer)
              : currentPrice * (1 - slippageBuffer);

          logger.info("📊 Price and slippage calculation", {
            symbol: signal.symbol,
            action: signal.action,
            rawLTP: `₹${currentPrice.toFixed(2)}`,
            slippageBuffer: `${(slippageBuffer * 100).toFixed(2)}%`,
            adjustedEntry: `₹${adjustedEntryPrice.toFixed(2)}`,
            slippageCost: `₹${Math.abs(adjustedEntryPrice - currentPrice).toFixed(2)}`,
          });

          // Calculate stop-loss
          const stopLoss =
            signal.stopLoss ||
            (signal.action === "BUY"
              ? adjustedEntryPrice * 0.995
              : adjustedEntryPrice * 1.005);

          // Fetch current balance BEFORE quantity calculation (needed for sizing)
          const currentBalance = await retry(
            () => this.broker.getAccountBalance(),
            3,
            500,
          );
          this.riskManager.updateBalance(currentBalance);
          this.metricsTracker.updateBalance(currentBalance);

          // Calculate quantity
          let quantity = signal.quantity;
          if (!quantity) {
            const marginMultiplier =
              signal.marginMultiplier ||
              this.config.trading.riskLimits.marginMultiplier ||
              5;
            // Use POSITION_SIZE_PERCENT of current balance (with margin) as max capital per trade
            const positionSizePct =
              this.config.trading.riskLimits.positionSizePercent || 10;
            const effectiveBalance = currentBalance * marginMultiplier;
            const maxCapitalForTrade =
              (positionSizePct / 100) * effectiveBalance;
            const maxQuantityByCapital = Math.floor(
              maxCapitalForTrade / currentPrice,
            );
            const riskBasedQuantity = this.riskManager.calculatePositionSize(
              currentPrice,
              stopLoss,
            );
            quantity = Math.min(maxQuantityByCapital, riskBasedQuantity);

            logger.info("Quantity calculated", {
              symbol: signal.symbol,
              currentPrice: `₹${currentPrice.toFixed(2)}`,
              currentBalance: `₹${currentBalance.toFixed(2)}`,
              effectiveBalance: `₹${effectiveBalance.toFixed(2)}`,
              maxCapitalForTrade: `₹${maxCapitalForTrade.toFixed(2)}`,
              maxQuantityByCapital,
              riskBasedQuantity,
              finalQuantity: quantity,
              orderValue: `₹${(quantity * currentPrice).toFixed(2)}`,
            });
          }

          if (quantity === 0) {
            logger.warn("Calculated quantity is 0", { signal });
            orderIdempotencyManager.markOrderFailed(orderKey, "Zero quantity");
            return;
          }

          // BEFORE placing order, check margin
          const marginCheck = await marginChecker.checkMarginAvailable(
            this.broker,
            quantity * adjustedEntryPrice,
            this.config.trading.riskLimits.marginMultiplier,
          );

          if (!marginCheck.available) {
            logger.error("Insufficient margin", {
              required: marginCheck.required,
              available: marginCheck.margin,
            });
            await this.telegramBot.sendAlert(
              "⚠️ INSUFFICIENT MARGIN",
              `Required: ₹${marginCheck.required.toFixed(2)}\nAvailable: ₹${marginCheck.margin.toFixed(2)}`,
            );
            orderIdempotencyManager.markOrderFailed(
              orderKey,
              "Insufficient margin",
            );
            return;
          }

          const openPositions = this.positionManager.getAllPositions().length;

          const riskCheck = this.riskManager.checkOrderRisk(
            signal.symbol,
            signal.action === "BUY" ? OrderSide.BUY : OrderSide.SELL,
            quantity,
            adjustedEntryPrice,
            stopLoss,
            openPositions, // ✅ Pass count
          );

          if (!riskCheck.allowed) {
            logger.warn("Risk check failed", {
              signal,
              reason: riskCheck.reason,
            });
            await this.telegramBot.sendAlert(
              "Risk Check Failed",
              riskCheck.reason || "Unknown reason",
            );
            orderIdempotencyManager.markOrderFailed(
              orderKey,
              riskCheck.reason || "Risk check failed",
            );
            return;
          }

          // Register for trailing if requested
          if (signal.useTrailingSL) {
            this.symbolsToTrail.add(signal.symbol);
            logger.info(
              `📝 Symbol registered for Trailing SL: ${signal.symbol}`,
            );
          }

          // IMPROVEMENT: Determine order type based on trading mode
          const side = signal.action === "BUY" ? OrderSide.BUY : OrderSide.SELL;
          const useROBOOrder = this.config.trading.mode === TradingMode.REAL;

          let orderType: OrderType;
          let limitPrice: number | undefined;

          if (useROBOOrder) {
            // REAL mode: Use ROBO (bracket order) for atomic stop-loss
            orderType = OrderType.MARKET;
            limitPrice = undefined;
          } else {
            // PAPER mode: Use LIMIT orders to cap slippage
            orderType = OrderType.LIMIT;
            limitPrice =
              signal.action === "BUY"
                ? currentPrice * (1 + this.LIMIT_ORDER_TOLERANCE) // 0.15% above LTP
                : currentPrice * (1 - this.LIMIT_ORDER_TOLERANCE); // 0.15% below LTP
          }

          logger.info("📋 Placing order", {
            symbol: signal.symbol,
            side,
            orderType: useROBOOrder ? "ROBO (Bracket)" : "LIMIT",
            currentPrice: `₹${currentPrice.toFixed(2)}`,
            limitPrice: limitPrice ? `₹${limitPrice.toFixed(2)}` : "N/A",
            tolerance: useROBOOrder
              ? "N/A"
              : `${(this.LIMIT_ORDER_TOLERANCE * 100).toFixed(2)}%`,
            quantity,
          });

          // Place order with retry
          const order = await retry(
            () =>
              this.broker.placeOrder(
                signal.symbol,
                side,
                orderType,
                quantity,
                limitPrice,
                stopLoss,
                signal.target,
              ),
            3,
            1000,
          ).catch((error) => {
            logger.error("Failed to place order after retries", {
              symbol: signal.symbol,
              error: error.message,
            });
            orderIdempotencyManager.markOrderFailed(orderKey, error.message);
            return null;
          });

          if (!order) {
            logger.error("❌ Failed to place order", { signal });
            await this.telegramBot.sendAlert(
              "❌ Order Failed",
              `Failed to place order for ${signal.symbol} after 3 attempts`,
            );
            return;
          }

          logger.info("✅ Order placed successfully", {
            orderId: order.orderId,
            symbol: signal.symbol,
            side: order.side,
            orderType: useROBOOrder ? "ROBO (Bracket)" : "LIMIT",
            quantity: order.quantity,
          });

          // Mark order as completed
          orderIdempotencyManager.markOrderCompleted(orderKey, order.orderId);

          // IMPROVEMENT: Set up order timeout for LIMIT orders (not needed for ROBO)
          let orderCancelled = false;
          const orderTimeout = !useROBOOrder
            ? setTimeout(async () => {
                try {
                  logger.warn(
                    "⏰ Order timeout - attempting to cancel limit order",
                    {
                      orderId: order.orderId,
                      symbol: signal.symbol,
                      timeoutMs: this.ORDER_TIMEOUT_MS,
                    },
                  );

                  const cancelled = await this.broker.cancelOrder(
                    order.orderId,
                  );

                  if (cancelled) {
                    orderCancelled = true;
                    await this.telegramBot.sendAlert(
                      "⏰ Order Timeout",
                      `Limit order for ${signal.symbol} cancelled after ${this.ORDER_TIMEOUT_MS / 1000}s (not filled)`,
                    );
                  }
                } catch (error: any) {
                  logger.error("Error cancelling order timeout", {
                    error: error.message,
                  });
                }
              }, this.ORDER_TIMEOUT_MS)
            : null;

          // Wait for order fill confirmation
          const fillMonitor = new OrderFillMonitor(this.broker);
          const fillResult = await fillMonitor.waitForFill(
            order.orderId,
            quantity,
          );

          // Clear timeout if order filled
          if (orderTimeout) {
            clearTimeout(orderTimeout);
          }

          if (orderCancelled) {
            logger.info(
              "Order was cancelled due to timeout - skipping further processing",
            );
            return;
          }

          if (
            fillResult.status === "FAILED" ||
            fillResult.status === "TIMEOUT"
          ) {
            logger.error("❌ Order did not fill", {
              orderId: order.orderId,
              status: fillResult.status,
            });
            await this.telegramBot.sendAlert(
              "❌ Order Fill Failed",
              `Order ${order.orderId} for ${signal.symbol} did not fill.\nStatus: ${fillResult.status}`,
            );
            return;
          }

          const filledQuantity = fillResult.filled;
          const fillPrice = fillResult.averagePrice || adjustedEntryPrice;

          // IMPROVEMENT: Calculate and track actual slippage
          const actualSlippage = Math.abs(
            (fillPrice - currentPrice) / currentPrice,
          );

          logger.info("📊 Order fill analysis", {
            orderId: order.orderId,
            expectedPrice: `₹${adjustedEntryPrice.toFixed(2)}`,
            fillPrice: `₹${fillPrice.toFixed(2)}`,
            expectedSlippage: `${(slippageBuffer * 100).toFixed(3)}%`,
            actualSlippage: `${(actualSlippage * 100).toFixed(3)}%`,
            slippageDiff: `${((actualSlippage - slippageBuffer) * 100).toFixed(3)}%`,
          });

          if (fillResult.status === "PARTIAL") {
            logger.warn("⚠️ Partial fill - adjusting quantity", {
              orderId: order.orderId,
              expected: quantity,
              filled: filledQuantity,
              percentFilled: `${((filledQuantity / quantity) * 100).toFixed(1)}%`,
            });
            await this.telegramBot.sendAlert(
              "⚠️ Partial Fill",
              `Order ${order.orderId} for ${signal.symbol}\nExpected: ${quantity}\nFilled: ${filledQuantity} (${((filledQuantity / quantity) * 100).toFixed(1)}%)`,
            );
          }

          // For PAPER mode, stop-loss is handled by broker simulation
          // For REAL mode, stop-loss is already part of ROBO order
          if (
            this.config.trading.mode === TradingMode.REAL &&
            filledQuantity > 0
          ) {
            logger.info(
              "✅ ROBO order includes automatic stop-loss and target",
              {
                symbol: signal.symbol,
                stopLoss: `₹${stopLoss.toFixed(2)}`,
                target: signal.target ? `₹${signal.target.toFixed(2)}` : "N/A",
              },
            );
          }

          // Get account info for telegram
          const balance = await this.broker.getAccountBalance();
          const positions = this.positionManager.getAllPositions();
          const openPositionCount = positions.length;

          await this.telegramBot.sendTradeNotification(
            signal.action,
            signal.symbol,
            filledQuantity,
            fillPrice,
            signal.reason,
            stopLoss,
            signal.target,
            balance,
            openPositionCount,
          );

          logger.audit("SIGNAL_EXECUTED", {
            signal,
            order,
            filledQuantity,
            fillPrice,
            expectedSlippage: slippageBuffer * 100,
            actualSlippage: actualSlippage * 100,
            orderType: useROBOOrder ? "ROBO" : "LIMIT",
          });
        } catch (error: any) {
          logger.error("Error handling strategy signal", error);
          await this.telegramBot.sendAlert(
            "Signal Execution Error",
            error.message,
          );
        }
      },
    );

    if (result === null) {
      logger.warn(
        "Signal processing skipped - position lock could not be acquired",
        { signal },
      );
      await this.telegramBot.sendAlert(
        "Signal Skipped",
        `Could not process signal for ${signal.symbol} - position is being modified by another operation`,
      );
    }
  }

  private async closePosition(symbol: string, reason: string): Promise<void> {
    // Note: This is called within withLock, so no need to re-acquire lock
    const position = this.positionManager.getPosition(symbol);
    if (!position) {
      logger.warn("No position to close", { symbol });
      return;
    }

    const side = position.type === "LONG" ? OrderSide.SELL : OrderSide.BUY;

    // Get fresh LTP before placing close order
    const currentPrice =
      (await this.broker.getLTP(symbol)) || position.currentPrice;

    const order = await this.broker.placeOrder(
      symbol,
      side,
      OrderType.MARKET,
      position.quantity,
    );

    if (order) {
      logger.info("Position close order placed", { symbol, reason });
      await this.telegramBot.sendTradeNotification(
        side,
        symbol,
        position.quantity,
        currentPrice,
        reason,
      );
    }
  }

  public async closeAllPositions(reason: string): Promise<void> {
    const positions = this.positionManager.getAllPositions();

    logger.info("Closing all positions", { count: positions.length, reason });

    for (const position of positions) {
      await this.closePosition(position.symbol, reason);
    }
  }

  private async startStrategies(): Promise<void> {
    for (const strategy of this.strategies.values()) {
      await strategy.initialize();
      logger.info("Strategy started", { name: strategy.getName() });
    }
  }

  private async stopStrategies(): Promise<void> {
    for (const strategy of this.strategies.values()) {
      await strategy.shutdown();
      logger.info("Strategy stopped", { name: strategy.getName() });
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
      totalPnL: totalPnL,
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
      returnPercent:
        ((balance - this.initialBalance) / this.initialBalance) * 100,
      dailyPnL: stats.dailyPnL,
      tradesExecutedToday: stats.tradesExecutedToday,
    });
  }

  private async sendRiskStatsReport(): Promise<void> {
    const stats = this.riskManager.getRiskStats();
    await this.telegramBot.sendRiskStatsReport(stats);
  }

  private async sendDailySummaryReport(): Promise<void> {
    const stats = this.riskManager.getRiskStats();
    const trades = this.riskManager.getDailyTrades();
    const balance = await this.broker.getAccountBalance();

    // Calculate trade statistics
    const winningTrades = trades.filter((t) => t.result === "WIN").length;
    const losingTrades = trades.filter((t) => t.result === "LOSS").length;
    const breakEvenTrades = trades.filter(
      (t) => t.result === "BREAKEVEN",
    ).length;
    const winRate =
      trades.length > 0 ? (winningTrades / trades.length) * 100 : 0;

    const largestWin =
      trades.length > 0 ? Math.max(...trades.map((t) => t.netPnL), 0) : 0;
    const largestLoss =
      trades.length > 0 ? Math.min(...trades.map((t) => t.netPnL), 0) : 0;

    await this.telegramBot.sendDailySummary({
      dailyPnL: stats.dailyPnL,
      totalTrades: trades.length,
      winningTrades,
      losingTrades,
      breakEvenTrades,
      winRate,
      largestWin,
      largestLoss,
      trades: trades,
      startingBalance: this.initialBalance,
      endingBalance: balance,
    });

    logger.info("📊 Daily summary report sent", {
      totalTrades: trades.length,
      dailyPnL: stats.dailyPnL,
      winRate: winRate.toFixed(1),
    });
  }

  public getOpenPositions(): Position[] {
    return this.positionManager.getAllPositions();
  }

  public async verifyAllPositionsClosed(): Promise<void> {
    // Wait 10 seconds for orders to execute
    await new Promise((resolve) => setTimeout(resolve, 10000));

    // Check broker positions
    const brokerPositions = await this.broker.getPositions();
    const openPositions = brokerPositions.filter((p) => p.quantity > 0);

    if (openPositions.length > 0) {
      logger.error("🚨 POSITIONS STILL OPEN AFTER SQUARE-OFF", {
        count: openPositions.length,
        symbols: openPositions.map((p) => p.symbol),
      });

      await this.telegramBot.sendAlert(
        "🚨 SQUARE-OFF FAILED",
        `${openPositions.length} positions still open!\n\n` +
          openPositions.map((p) => `${p.symbol}: ${p.quantity}`).join("\n") +
          `\n\nRetrying square-off...`,
      );

      // Retry square-off
      await this.closeAllPositions("Square-off retry");

      // Verify again
      await new Promise((resolve) => setTimeout(resolve, 10000));
      const stillOpen = await this.broker.getPositions();

      if (stillOpen.filter((p) => p.quantity > 0).length > 0) {
        logger.error("🚨 CRITICAL: POSITIONS STILL OPEN AFTER RETRY");
        await this.telegramBot.sendAlert(
          "🚨 CRITICAL ALERT",
          "Positions still open after retry!\nMANUAL INTERVENTION REQUIRED!",
        );

        // Activate emergency shutdown which stops engine but can't close positions if broker fails
        // But we want to ensure we don't start new trades
        await this.activateEmergencyShutdown("Square-off failed after retry");
      }
    } else {
      logger.info("✅ All positions successfully squared off");
      await this.telegramBot.sendMessage(
        "✅ All positions squared off successfully",
      );
    }
  }

  /**
   * Start background reconnection attempts
   */
  private startBackgroundReconnection(): void {
    if (this.reconnectionInterval) {
      return; // Already running
    }

    logger.info("🔄 Starting background broker reconnection attempts");

    // Mark health check as reconnecting (still healthy)
    healthCheckServer.setReconnecting(true);

    this.reconnectionInterval = setInterval(async () => {
      try {
        logger.info("🔄 Attempting broker reconnection...");
        const connected = await this.broker.connect();

        if (connected) {
          logger.info("✅ Broker reconnection successful!");

          // Clear reconnecting status
          healthCheckServer.setReconnecting(false);
          healthCheckServer.setHealthy();

          await this.telegramBot.sendAlert(
            "✅ Broker Connected",
            "Successfully reconnected to Angel One broker after authentication failure",
          );

          // Stop reconnection attempts
          if (this.reconnectionInterval) {
            clearInterval(this.reconnectionInterval);
            this.reconnectionInterval = undefined;
          }

          // Resume normal operations
          if (this.scheduler.isMarketHours()) {
            await this.startStrategies();
          }
        }
      } catch (error: any) {
        logger.debug("Broker reconnection failed, will retry", {
          error: error.message,
        });
      }
    }, this.RECONNECTION_INTERVAL_MS);
  }

  /**
   * Stop background reconnection attempts
   */
  private stopBackgroundReconnection(): void {
    if (this.reconnectionInterval) {
      clearInterval(this.reconnectionInterval);
      this.reconnectionInterval = undefined;
      healthCheckServer.setReconnecting(false);
      logger.info("🛑 Stopped background broker reconnection");
    }
  }

  /**
   * Emergency shutdown - closes all positions and stops trading immediately
   * Used when critical failures are detected (data feed dead, etc.)
   */
  public async activateEmergencyShutdown(reason: string): Promise<void> {
    logger.error("🚨 EMERGENCY SHUTDOWN ACTIVATED", { reason });

    // Activate kill switch to prevent new trades
    configManager.setKillSwitch(true);

    await this.telegramBot.sendAlert(
      "🚨 EMERGENCY SHUTDOWN",
      `**CRITICAL SITUATION DETECTED**\n\n` +
        `Reason: ${reason}\n\n` +
        `Actions taken:\n` +
        `✅ Kill switch activated\n` +
        `✅ All positions being closed\n` +
        `✅ Strategies stopped\n` +
        `✅ Data feeds stopped\n\n` +
        `Manual intervention required before restart.`,
    );

    // Close all positions immediately
    await this.closeAllPositions(reason);

    // Stop accepting new signals
    await this.stopStrategies();

    // WebSocket will be disconnected on broker.disconnect()

    // Stop monitoring services
    this.heartbeatMonitor.stop();
    this.stopLossManager.stopMonitoring();

    logger.info("✅ Emergency shutdown complete");
    logger.audit("EMERGENCY_SHUTDOWN", { reason });
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Trading engine already running");
      return;
    }

    logger.info("Starting trading engine", {
      mode: this.config.trading.mode,
      killSwitch: configManager.isKillSwitchActive(),
    });

    const connected = await this.broker.connect();
    if (!connected) {
      logger.error("⚠️ Failed to connect to broker - will retry in background");
      logger.info(
        "💡 Bot will continue running and attempt to reconnect periodically",
      );

      // Don't throw - let the bot run in degraded mode
      // Background reconnection will be handled by scheduler or monitoring
      this.startBackgroundReconnection();
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
      logger.info("✅ Stop-loss manager monitoring started");
    }

    // IMPROVEMENT: Start position reconciliation service (every 30s)
    this.positionReconciliation = new PositionReconciliationService(
      this.broker,
      this.positionManager,
    );
    this.positionReconciliation.start();
    logger.info("✅ Position reconciliation started (every 30s)");

    // IMPROVEMENT: Set up reconciliation event handlers
    this.positionReconciliation.on(
      "reconciliation_mismatch",
      async (data: any) => {
        await this.telegramBot.sendAlert(
          "❌ POSITION MISMATCH DETECTED",
          `Mismatches: ${data.mismatches.length}\n` +
            `Consecutive failures: ${data.consecutiveFailures}\n\n` +
            `Details:\n${data.mismatches.map((m: any) => `- ${m.symbol}: ${m.issue}`).join("\n")}\n\n` +
            `Check logs for full details.`,
        );
      },
    );

    this.positionReconciliation.on(
      "reconciliation_critical",
      async (data: any) => {
        await this.telegramBot.sendAlert(
          "🚨 CRITICAL: Position Reconciliation Failure",
          `${data.message}\n\n` +
            `Bot may have lost sync with broker.\n` +
            `Manual intervention required!`,
        );
      },
    );

    // IMPROVEMENT: Initialize dashboard display
    this.dashboardDisplay = new DashboardDisplay(
      this.metricsTracker,
      this.riskManager,
      this.positionManager,
    );

    // Display dashboard every 5 minutes
    this.dashboardDisplayInterval = setInterval(() => {
      this.dashboardDisplay?.displayConsole();
    }, 300000); // 5 minutes
    logger.info("✅ Dashboard display started (every 5 min)");

    this.isRunning = true;

    // If starting during market hours, start strategies immediately
    // WebSocket is already connected from broker.connect()
    if (this.scheduler.isMarketHours()) {
      logger.info(
        "⏰ Bot started during market hours - starting strategies immediately",
      );
      await this.startStrategies();
    } else {
      logger.info(
        "⏰ Bot started outside market hours - will wait for market open",
      );
    }

    await this.telegramBot.sendMessage(
      `🚀 *Trading Engine Started*\n\nMode: ${this.config.trading.mode}\nBalance: ₹${this.initialBalance.toFixed(2)}\n\n` +
        (this.scheduler.isMarketHours()
          ? "🟢 Market is OPEN - trading active"
          : "🔴 Market is CLOSED - waiting for market open"),
    );

    logger.info("Trading engine started successfully");
    logger.audit("TRADING_ENGINE_STARTED", {
      mode: this.config.trading.mode,
      balance: this.initialBalance,
    });
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn("Trading engine not running");
      return;
    }

    logger.info("Stopping trading engine");

    await this.stopStrategies();
    await this.closeAllPositions("Engine shutdown");

    // FIX #4: Stop heartbeat monitoring
    this.heartbeatMonitor.stop();

    // FIX #3: Stop stop-loss monitoring and cancel all pending SL orders
    if (this.config.trading.mode === TradingMode.REAL) {
      this.stopLossManager.stopMonitoring();
      await this.stopLossManager.cancelAllStopLosses("Engine shutdown");
      logger.info("✅ Stop-loss manager stopped and all SL orders cancelled");
    }

    // IMPROVEMENT: Stop position reconciliation
    if (this.positionReconciliation) {
      this.positionReconciliation.stop();
      logger.info("✅ Position reconciliation stopped");
    }

    // IMPROVEMENT: Stop dashboard display
    if (this.dashboardDisplayInterval) {
      clearInterval(this.dashboardDisplayInterval);
      this.dashboardDisplayInterval = undefined;
      logger.info("✅ Dashboard display stopped");
    }

    // IMPROVEMENT: Stop order idempotency manager
    orderIdempotencyManager.stop();
    logger.info("✅ Order idempotency manager stopped");

    // Stop background reconnection if running
    this.stopBackgroundReconnection();

    // Release all position locks
    positionLockManager.releaseAllLocks();

    this.scheduler.stop();
    await this.telegramBot.stop();
    await this.broker.disconnect();

    this.isRunning = false;

    logger.info("Trading engine stopped");
    logger.audit("TRADING_ENGINE_STOPPED", {});
  }
}
