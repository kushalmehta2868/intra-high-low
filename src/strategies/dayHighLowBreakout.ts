import { BaseStrategy } from "./base";
import {
  StrategyContext,
  MarketData,
  StrategySignal,
  Position,
} from "../types";
import { logger } from "../utils/logger";
import { getSymbolMarginMultiplier } from "../config/symbolConfig";
import { avgVolume, calculateATR, get30MinTrend } from "../utils/indicators";
import { CandleBundle } from "../services/candleDataService";
import { strategyStateStore } from "../services/strategyStateStore";

interface PendingSignal {
  direction: 'BUY' | 'SELL';
  breakoutLevel: number;
}

interface SymbolState {
  // Current day OHLC
  dayHigh: number;
  dayLow: number;
  open: number;

  // Track previous LTP for cross detection
  prevLtp: number;

  // Breakout flags - ensure single signal per direction per cooldown window
  hasBrokenHighToday: boolean;
  hasBrokenLowToday: boolean;

  // Hard cap: max 2 trades per stock per calendar day
  tradesExecutedToday: number;

  // Cooldown after position close
  positionClosedAt: number | null; // Timestamp when position was closed
  isInCooldown: boolean; // Whether symbol is in cooldown period

  // 2-tick breakout confirmation: set on first cross, cleared on confirm/cancel
  pendingSignal: PendingSignal | null;

  // Circuit breaker detection: timestamp of last price movement
  lastPriceChangeAt: number;

  lastLogTime: number; // Track last log time for periodic logging
  lastResetDate: string; // Track when we last reset for new day (IST YYYY-MM-DD)
}

export class DayHighLowBreakoutStrategy extends BaseStrategy {
  private symbolStates: Map<string, SymbolState> = new Map();
  private watchlist: string[] = [];
  private cachedVolumeRatios: Map<string, number> = new Map();
  private cachedATRs: Map<string, number> = new Map();
  private cachedTrends: Map<string, 'UP' | 'DOWN' | 'NEUTRAL'> = new Map();
  private readonly LOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes in milliseconds
  private readonly COOLDOWN_PERIOD_MS = 10 * 60 * 1000; // 10 minutes cooldown after position close

  constructor(context: StrategyContext, watchlist: string[] = []) {
    super("DayHighLowBreakout", context);
    this.watchlist = watchlist;
  }

  public async initialize(): Promise<void> {
    await super.initialize();

    // Load persisted state for today (survives bot restarts mid-day)
    const savedStates = strategyStateStore.loadTodayState();
    const restoredSymbols: string[] = [];

    for (const symbol of this.watchlist) {
      const saved = savedStates[symbol];
      const now = Date.now();

      let restoredCooldown = false;
      let restoredTrades = 0;
      let positionClosedAt: number | null = null;
      let isInCooldown = false;

      if (saved) {
        restoredTrades = saved.tradesExecutedToday;
        if (saved.isInCooldown && saved.cooldownExpiresAt !== null) {
          if (saved.cooldownExpiresAt > now) {
            // Cooldown still active — restore with adjusted positionClosedAt
            isInCooldown = true;
            positionClosedAt = saved.cooldownExpiresAt - this.COOLDOWN_PERIOD_MS;
            restoredCooldown = true;
          }
          // else: cooldown expired during downtime — start fresh, no cooldown
        }
        restoredSymbols.push(symbol);
      }

      this.symbolStates.set(symbol, {
        dayHigh: 0,
        dayLow: Infinity,
        open: 0,
        prevLtp: 0,
        hasBrokenHighToday: false,
        hasBrokenLowToday: false,
        tradesExecutedToday: restoredTrades,
        positionClosedAt,
        isInCooldown,
        pendingSignal: null,
        lastPriceChangeAt: now,
        lastLogTime: 0,
        lastResetDate: saved?.lastResetDate || "",
      });

      if (saved) {
        logger.info(`[${symbol}] Restored persistent state`, {
          tradesExecutedToday: restoredTrades,
          cooldownRestored: restoredCooldown,
          cooldownEndsAt: restoredCooldown && positionClosedAt
            ? new Date(positionClosedAt + this.COOLDOWN_PERIOD_MS).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
            : 'N/A',
        });
      }
    }

    if (restoredSymbols.length > 0) {
      logger.info(`DayHighLowBreakout strategy initialized with restored state for ${restoredSymbols.length} symbol(s)`);
    } else {
      logger.info("DayHighLowBreakout strategy initialized (fresh state)", {
        watchlist: this.watchlist,
      });
    }
  }

  public onMarketData(data: MarketData): void {
    if (!this.isActive) return;

    const state = this.symbolStates.get(data.symbol);
    if (!state) return;

    // Check if it's a new trading day and reset accordingly
    this.checkAndResetForNewDay(state);

    // Check and clear cooldown if period has elapsed
    this.checkCooldownExpiry(data.symbol, state);

    // Set opening price AND initialize high/low on first data point
    if (state.open === 0) {
      state.open = data.open || data.ltp;
      state.dayHigh = data.high || data.ltp; // Initialize from real data, not 0
      state.dayLow = data.low || data.ltp; // Initialize from real data, not Infinity
      state.prevLtp = data.ltp;
      state.lastPriceChangeAt = Date.now();
      logger.info(`📊 [${data.symbol}] Day initialized from first tick`, {
        open: `₹${state.open.toFixed(2)}`,
        dayHigh: `₹${state.dayHigh.toFixed(2)}`,
        dayLow: `₹${state.dayLow.toFixed(2)}`,
        ltp: `₹${data.ltp.toFixed(2)}`,
      });
    }

    // Track price movement for circuit breaker detection
    if (data.ltp !== state.prevLtp) {
      state.lastPriceChangeAt = Date.now();
    }

    // Check pending signal confirmation (2-tick confirmation logic)
    if (state.pendingSignal) {
      this.checkPendingSignalConfirmation(data.symbol, data.ltp, state);
    }

    // Cache previous levels BEFORE update
    const prevDayHigh = state.dayHigh;
    const prevDayLow = state.dayLow;

    // Detect breakout using previous levels (only if no pending signal already)
    if (!state.pendingSignal) {
      this.checkForBreakout(data, state, prevDayHigh, prevDayLow);
    }

    // Now update current day's high/low
    state.dayHigh = Math.max(state.dayHigh, data.high, data.ltp);
    state.dayLow = Math.min(state.dayLow, data.low, data.ltp);

    // Log price levels every 5 minutes
    this.logPriceLevels(data, state);

    // Update prevLtp for next tick
    state.prevLtp = data.ltp;
  }

  /**
   * Check if it's a new trading day and reset state accordingly
   */
  private checkAndResetForNewDay(state: SymbolState): void {
    // Use IST date so the reset happens at IST midnight, not UTC midnight
    const istDate = new Date().toLocaleString("en-CA", { timeZone: "Asia/Kolkata" }).split(",")[0].trim();

    if (state.lastResetDate !== istDate) {
      // Clear persisted state file when a new day is detected
      if (state.lastResetDate !== "") {
        strategyStateStore.clearDailyState();
      }

      // Reset for new trading day
      state.dayHigh = 0;
      state.dayLow = Infinity;
      state.open = 0;
      state.prevLtp = 0;
      state.hasBrokenHighToday = false;
      state.hasBrokenLowToday = false;
      state.tradesExecutedToday = 0;
      state.positionClosedAt = null;
      state.isInCooldown = false;
      state.pendingSignal = null;
      state.lastPriceChangeAt = Date.now();
      state.lastResetDate = istDate;

      logger.info(`🔄 New trading day - state reset`, { date: istDate });
    }
  }

  /**
   * Check if cooldown period has expired and clear it
   */
  private checkCooldownExpiry(symbol: string, state: SymbolState): void {
    if (state.isInCooldown && state.positionClosedAt !== null) {
      const now = Date.now();
      const timeSinceClose = now - state.positionClosedAt;

      if (timeSinceClose >= this.COOLDOWN_PERIOD_MS) {
        state.isInCooldown = false;
        state.positionClosedAt = null;

        // Persist updated state after cooldown expires
        this.saveSymbolState(symbol, state);

        const MAX_TRADES_PER_STOCK_PER_DAY = 2;
        const remainingTrades = MAX_TRADES_PER_STOCK_PER_DAY - state.tradesExecutedToday;

        if (remainingTrades > 0) {
          // Allow re-entry in both directions for remaining trade slots
          state.hasBrokenHighToday = false;
          state.hasBrokenLowToday = false;
          logger.info(
            `⏰ [${symbol}] Cooldown ended - ready for new signals (${remainingTrades} trade(s) remaining today)`,
            { cooldownDuration: `${(timeSinceClose / 60000).toFixed(1)} min` },
          );
        } else {
          // Daily cap reached — cooldown cleared but no new signals allowed
          logger.info(
            `⏰ [${symbol}] Cooldown ended - daily trade limit reached (${MAX_TRADES_PER_STOCK_PER_DAY}/${MAX_TRADES_PER_STOCK_PER_DAY}), no more signals today`,
          );
        }
      }
    }
  }

  /**
   * Saves the persistent portion of a symbol's state to disk.
   */
  private saveSymbolState(symbol: string, state: SymbolState): void {
    const istDate = new Date().toLocaleString("en-CA", { timeZone: "Asia/Kolkata" }).split(",")[0].trim();
    strategyStateStore.saveSymbolState(symbol, {
      tradesExecutedToday: state.tradesExecutedToday,
      isInCooldown: state.isInCooldown,
      cooldownExpiresAt: state.positionClosedAt !== null
        ? state.positionClosedAt + this.COOLDOWN_PERIOD_MS
        : null,
      lastResetDate: istDate,
    });
  }

  /**
   * 2-tick confirmation: if the pending signal direction is still valid on the
   * next tick, emit the signal. If price reversed, cancel and allow re-detection.
   */
  private checkPendingSignalConfirmation(symbol: string, ltp: number, state: SymbolState): void {
    const pending = state.pendingSignal!;

    const atr = this.cachedATRs.get(symbol);

    if (pending.direction === 'BUY') {
      if (ltp > pending.breakoutLevel) {
        // Confirmed: price still above breakout level on second tick
        state.pendingSignal = null;
        state.tradesExecutedToday++;
        this.saveSymbolState(symbol, state);
        this.on_buy_signal(symbol, ltp, pending.breakoutLevel, state.prevLtp, atr);
      } else {
        // Reversed: cancel pending signal, reset flag so we can try again
        logger.info(`🔁 [${symbol}] BUY breakout not confirmed (price reversed) - resetting`, {
          breakoutLevel: `₹${pending.breakoutLevel.toFixed(2)}`,
          currentLtp: `₹${ltp.toFixed(2)}`,
        });
        state.pendingSignal = null;
        state.hasBrokenHighToday = false;
      }
    } else {
      if (ltp < pending.breakoutLevel) {
        // Confirmed: price still below breakout level on second tick
        state.pendingSignal = null;
        state.tradesExecutedToday++;
        this.saveSymbolState(symbol, state);
        this.on_sell_signal(symbol, ltp, pending.breakoutLevel, state.prevLtp, atr);
      } else {
        // Reversed: cancel pending signal, reset flag so we can try again
        logger.info(`🔁 [${symbol}] SELL breakout not confirmed (price reversed) - resetting`, {
          breakoutLevel: `₹${pending.breakoutLevel.toFixed(2)}`,
          currentLtp: `₹${ltp.toFixed(2)}`,
        });
        state.pendingSignal = null;
        state.hasBrokenLowToday = false;
      }
    }
  }

  private logPriceLevels(data: MarketData, state: SymbolState): void {
    const now = Date.now();

    // Log every 5 minutes OR on first data point
    if (
      state.lastLogTime === 0 ||
      now - state.lastLogTime >= this.LOG_INTERVAL_MS
    ) {
      state.lastLogTime = now;

      const distanceToHigh =
        state.dayHigh > 0 ? ((state.dayHigh - data.ltp) / data.ltp) * 100 : 0;
      const distanceToLow =
        state.dayLow !== Infinity
          ? ((data.ltp - state.dayLow) / data.ltp) * 100
          : 0;

      // Determine status
      let status = "⏸️  Consolidating";
      if (distanceToHigh < 0.1 && !state.hasBrokenHighToday) {
        status = "🔥 Near High Breakout!";
      } else if (distanceToLow < 0.1 && !state.hasBrokenLowToday) {
        status = "❄️  Near Low Breakout!";
      }

      // Get cached candle volume ratio
      const volRatio = this.cachedVolumeRatios.get(data.symbol);
      const volumeInfo = volRatio !== undefined
        ? `${data.volume > 0 ? data.volume.toLocaleString() : "N/A"} (${volRatio.toFixed(2)}x avg)`
        : data.volume > 0
          ? data.volume.toLocaleString()
          : "N/A";

      logger.info(`📊 [${data.symbol}] Price Levels Check`, {
        symbol: data.symbol,
        status: status,
        currentPrice: `₹${data.ltp.toFixed(2)}`,
        dayHigh: `₹${state.dayHigh.toFixed(2)}`,
        dayLow: `₹${state.dayLow !== Infinity ? state.dayLow.toFixed(2) : "N/A"}`,
        open: `₹${state.open.toFixed(2)}`,
        volume: volumeInfo,
        distanceToHigh: `${distanceToHigh.toFixed(2)}%`,
        distanceToLow: `${distanceToLow.toFixed(2)}%`,
        hasBrokenHigh: state.hasBrokenHighToday,
        hasBrokenLow: state.hasBrokenLowToday,
        timestamp: new Date().toLocaleTimeString("en-IN", {
          timeZone: "Asia/Kolkata",
        }),
      });
    }
  }

  /**
   * Check for breakout using EXACT cross-above/cross-below logic
   * Buy: prevLtp <= dayHigh AND ltp > dayHigh (cross ABOVE current day high)
   * Sell: prevLtp >= dayLow AND ltp < dayLow (cross BELOW current day low)
   */
  private checkForBreakout(
    data: MarketData,
    state: SymbolState,
    dayHigh: number,
    dayLow: number,
  ): void {
    // Skip if we already have a position
    const existingPosition = this.context.positions.get(data.symbol);
    if (existingPosition && existingPosition.quantity !== 0) {
      return;
    }

    // Skip if symbol is in cooldown period
    if (state.isInCooldown) {
      return;
    }

    // Hard cap: maximum 2 trades per stock per day
    const MAX_TRADES_PER_STOCK_PER_DAY = 2;
    if (state.tradesExecutedToday >= MAX_TRADES_PER_STOCK_PER_DAY) {
      return;
    }

    // Can't check cross without previous LTP or valid day high/low
    if (
      state.prevLtp === 0 ||
      state.dayHigh === 0 ||
      state.dayLow === Infinity
    ) {
      return;
    }

    // SHOULD FIX #8 — Gap-up / gap-down guard: skip breakout signals in first 5 minutes.
    // Gap opens create false breakouts where open price == day high/low.
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const currentTime = `${String(istNow.getHours()).padStart(2, '0')}:${String(istNow.getMinutes()).padStart(2, '0')}`;
    if (currentTime < '09:20') {
      return;
    }

    // SHOULD FIX #11 — Circuit breaker guard: if price has not moved in 3+ minutes,
    // the stock is likely halted. Skip signals to avoid acting on stale data.
    const CIRCUIT_FREEZE_MS = 3 * 60 * 1000;
    if (Date.now() - state.lastPriceChangeAt > CIRCUIT_FREEZE_MS) {
      logger.warn(`⛔ [${data.symbol}] Price frozen for 3+ min - possible circuit breaker, skipping signal`);
      return;
    }

    const ltp = data.ltp;
    const prevLtp = state.prevLtp;
    const trend = this.cachedTrends.get(data.symbol) ?? 'NEUTRAL';

    const crossedAboveHigh = prevLtp <= dayHigh && ltp > dayHigh;
    const crossedBelowLow = prevLtp >= dayLow && ltp < dayLow;

    if (crossedAboveHigh && !state.hasBrokenHighToday) {
      // Trend filter: 30-min trend must be UP for a BUY breakout
      if (trend !== 'UP') {
        logger.info(`🚫 [${data.symbol}] BUY breakout rejected - 30-min trend is ${trend}`);
        return;
      }

      // Check 5-min candle volume: current candle must be > 1.5× 20-bar average
      const volRatio = this.cachedVolumeRatios.get(data.symbol) ?? 0;
      if (volRatio < 1.5) {
        logger.info(`🚫 [${data.symbol}] BUY signal rejected - insufficient volume (${volRatio.toFixed(2)}x, need 1.5x)`);
        return;
      }

      // 2-tick confirmation: set pending signal, emit on next tick if confirmed
      state.hasBrokenHighToday = true;
      state.pendingSignal = { direction: 'BUY', breakoutLevel: dayHigh };
      logger.info(`⏳ [${data.symbol}] BUY breakout detected - awaiting 1-tick confirmation`, {
        dayHigh: `₹${dayHigh.toFixed(2)}`,
        ltp: `₹${ltp.toFixed(2)}`,
        volumeRatio: `${volRatio.toFixed(2)}x`,
      });
      return;
    }

    if (crossedBelowLow && !state.hasBrokenLowToday) {
      // Trend filter: 30-min trend must be DOWN for a SELL breakout
      if (trend !== 'DOWN') {
        logger.info(`🚫 [${data.symbol}] SELL breakout rejected - 30-min trend is ${trend}`);
        return;
      }

      // Check 5-min candle volume: current candle must be > 1.5× 20-bar average
      const volRatio = this.cachedVolumeRatios.get(data.symbol) ?? 0;
      if (volRatio < 1.5) {
        logger.info(`🚫 [${data.symbol}] SELL signal rejected - insufficient volume (${volRatio.toFixed(2)}x, need 1.5x)`);
        return;
      }

      // 2-tick confirmation
      state.hasBrokenLowToday = true;
      state.pendingSignal = { direction: 'SELL', breakoutLevel: dayLow };
      logger.info(`⏳ [${data.symbol}] SELL breakout detected - awaiting 1-tick confirmation`, {
        dayLow: `₹${dayLow.toFixed(2)}`,
        ltp: `₹${ltp.toFixed(2)}`,
        volumeRatio: `${volRatio.toFixed(2)}x`,
      });
      return;
    }
  }

  /**
   * Handle BUY signal when price crosses ABOVE day high
   */
  private on_buy_signal(
    symbol: string,
    ltp: number,
    dayHigh: number,
    prevLtp: number,
    atr?: number,
  ): void {
    // ATR-based SL/TP (1×ATR SL, 2×ATR target → 1:2 R:R)
    // Falls back to 0.25% / 0.5% fixed if ATR is not yet cached
    const stopLoss = atr ? ltp - atr       : ltp * (1 - 0.0025);
    const target   = atr ? ltp + atr * 2   : ltp * (1 + 0.005);

    // Get symbol-specific margin multiplier
    const marginMultiplier = getSymbolMarginMultiplier(symbol);

    const signal: StrategySignal = {
      symbol,
      action: "BUY",
      stopLoss,
      target,
      marginMultiplier,
      useTrailingSL: true, // Enable trailing SL for this strategy
      reason: `Crossed ABOVE day high at ₹${ltp.toFixed(2)} (Day High: ₹${dayHigh.toFixed(2)}, ATR: ${atr ? `₹${atr.toFixed(2)}` : 'fixed'})`,
      confidence: 0.8, // Increased confidence due to filters
    };

    const riskPerShare = ltp - stopLoss;
    const rewardPerShare = target - ltp;
    const riskRewardRatio = rewardPerShare / riskPerShare;

    logger.info("🚀 BUY SIGNAL - Price crossed ABOVE day high", {
      symbol,
      prevLtp: `₹${prevLtp.toFixed(2)}`,
      dayHigh: `₹${dayHigh.toFixed(2)}`,
      currentLtp: `₹${ltp.toFixed(2)}`,
      atr: atr ? `₹${atr.toFixed(2)}` : 'N/A (using fixed %)',
      stopLoss: `₹${stopLoss.toFixed(2)}`,
      target: `₹${target.toFixed(2)}`,
      riskReward: `1:${riskRewardRatio.toFixed(2)}`,
    });

    logger.audit("STRATEGY_SIGNAL", {
      strategy: this.name,
      signal,
    });

    this.emitSignal(signal);
  }

  /**
   * Handle SELL signal when price crosses BELOW day low
   */
  private on_sell_signal(
    symbol: string,
    ltp: number,
    dayLow: number,
    prevLtp: number,
    atr?: number,
  ): void {
    // ATR-based SL/TP (1×ATR SL, 2×ATR target → 1:2 R:R)
    // Falls back to 0.25% / 0.5% fixed if ATR is not yet cached
    const stopLoss = atr ? ltp + atr       : ltp * (1 + 0.0025);
    const target   = atr ? ltp - atr * 2   : ltp * (1 - 0.005);

    // Get symbol-specific margin multiplier
    const marginMultiplier = getSymbolMarginMultiplier(symbol);

    const signal: StrategySignal = {
      symbol,
      action: "SELL",
      stopLoss,
      target,
      marginMultiplier,
      useTrailingSL: true, // Enable trailing SL for this strategy
      reason: `Crossed BELOW day low at ₹${ltp.toFixed(2)} (Day Low: ₹${dayLow.toFixed(2)}, ATR: ${atr ? `₹${atr.toFixed(2)}` : 'fixed'})`,
      confidence: 0.8, // Increased confidence due to filters
    };

    const riskPerShare = stopLoss - ltp;
    const rewardPerShare = ltp - target;
    const riskRewardRatio = rewardPerShare / riskPerShare;

    logger.info("📉 SELL SIGNAL - Price crossed BELOW day low", {
      symbol,
      prevLtp: `₹${prevLtp.toFixed(2)}`,
      dayLow: `₹${dayLow.toFixed(2)}`,
      currentLtp: `₹${ltp.toFixed(2)}`,
      atr: atr ? `₹${atr.toFixed(2)}` : 'N/A (using fixed %)',
      stopLoss: `₹${stopLoss.toFixed(2)}`,
      target: `₹${target.toFixed(2)}`,
      riskReward: `1:${riskRewardRatio.toFixed(2)}`,
    });

    logger.audit("STRATEGY_SIGNAL", {
      strategy: this.name,
      signal,
    });

    this.emitSignal(signal);
  }

  /**
   * Called by CandleDataService after every 5-min candle refresh.
   * Caches the volume ratio (current candle vs 20-bar average) for use
   * in breakout signal filtering.
   */
  public handleCandleUpdate(symbol: string, bundle: CandleBundle, _ltp: number): void {
    const { fiveMin, thirtyMin } = bundle;

    // Volume ratio: current 5-min candle vs 20-bar average
    if (fiveMin.length >= 21) {
      const volAvg = avgVolume(fiveMin, 20);
      const currentVol = fiveMin[fiveMin.length - 1].volume;
      this.cachedVolumeRatios.set(symbol, volAvg > 0 ? currentVol / volAvg : 0);
    }

    // ATR(14) from 5-min candles — exclude the live (still-forming) candle
    if (fiveMin.length >= 16) {
      const atr = calculateATR(fiveMin.slice(0, -1), 14);
      if (atr) this.cachedATRs.set(symbol, atr);
    }

    // 30-min trend direction for the breakout gate
    this.cachedTrends.set(symbol, get30MinTrend(thirtyMin));
  }

  public onPositionUpdate(position: Position): void {
    const state = this.symbolStates.get(position.symbol);
    if (!state) return;

    if (position.quantity === 0) {
      // Position closed - start 10-minute cooldown
      state.positionClosedAt = Date.now();
      state.isInCooldown = true;
      state.pendingSignal = null; // Cancel any pending signal on close

      // Persist cooldown state immediately so restart survives
      this.saveSymbolState(position.symbol, state);

      logger.info(
        `🔒 [${position.symbol}] Position closed - 10-minute cooldown started`,
        {
          closedAt: new Date().toLocaleTimeString("en-IN", {
            timeZone: "Asia/Kolkata",
          }),
          cooldownEndsAt: new Date(
            Date.now() + this.COOLDOWN_PERIOD_MS,
          ).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }),
        },
      );
    }
  }

  public addSymbol(symbol: string): void {
    if (!this.symbolStates.has(symbol)) {
      this.watchlist.push(symbol);
      this.symbolStates.set(symbol, {
        dayHigh: 0,
        dayLow: Infinity,
        open: 0,
        prevLtp: 0,
        hasBrokenHighToday: false,
        hasBrokenLowToday: false,
        tradesExecutedToday: 0,
        positionClosedAt: null,
        isInCooldown: false,
        pendingSignal: null,
        lastPriceChangeAt: Date.now(),
        lastLogTime: 0,
        lastResetDate: "",
      });

      logger.info("Symbol added to strategy watchlist", { symbol });
    }
  }

  public removeSymbol(symbol: string): void {
    this.symbolStates.delete(symbol);
    this.watchlist = this.watchlist.filter((s) => s !== symbol);
    logger.info("Symbol removed from strategy watchlist", { symbol });
  }

  public getWatchlist(): string[] {
    return [...this.watchlist];
  }

  public resetDailyData(): void {
    // Use IST date (consistent with checkAndResetForNewDay)
    const today = new Date().toLocaleString("en-CA", { timeZone: "Asia/Kolkata" }).split(",")[0].trim();

    // Clear persisted state file for the new day
    strategyStateStore.clearDailyState();

    for (const state of this.symbolStates.values()) {
      // Reset current day's data
      state.dayHigh = 0;
      state.dayLow = Infinity;
      state.open = 0;
      state.prevLtp = 0;
      state.hasBrokenHighToday = false;
      state.hasBrokenLowToday = false;
      state.tradesExecutedToday = 0;
      state.positionClosedAt = null;
      state.isInCooldown = false;
      state.pendingSignal = null;
      state.lastPriceChangeAt = Date.now();
      state.lastLogTime = 0;
      state.lastResetDate = today;
    }

    // Reset cached candle-derived values for the new day
    this.cachedVolumeRatios.clear();
    this.cachedATRs.clear();
    this.cachedTrends.clear();

    logger.info("Daily data reset for all symbols");
    logger.audit("STRATEGY_DAILY_RESET", { strategy: this.name });
  }
}
