import { BaseStrategy } from "./base";
import {
  StrategyContext,
  MarketData,
  StrategySignal,
  Position,
} from "../types";
import { logger } from "../utils/logger";
import { getSymbolMarginMultiplier } from "../config/symbolConfig";
import { calculateATR, calculateRSI, calculateADX, get30MinTrend, sessionVolumeRatio } from "../utils/indicators";
import { CandleBundle } from "../services/candleDataService";
import { strategyStateStore } from "../services/strategyStateStore";

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

  // Circuit breaker detection: timestamp of last tick received (not price change)
  lastTickAt: number;

  lastLogTime: number; // Track last log time for periodic logging
  lastResetDate: string; // Track when we last reset for new day (IST YYYY-MM-DD)
}

export class DayHighLowBreakoutStrategy extends BaseStrategy {
  private symbolStates: Map<string, SymbolState> = new Map();
  private watchlist: string[] = [];
  private cachedVolumeRatios: Map<string, number> = new Map();
  private cachedATRs: Map<string, number> = new Map();
  private cachedTrends: Map<string, 'UP' | 'DOWN' | 'NEUTRAL'> = new Map();
  private cachedRSIs: Map<string, number> = new Map();
  private cachedADXs: Map<string, number> = new Map();
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
        dayHigh: saved?.dayHigh ?? 0,
        dayLow: saved?.dayLow ?? Infinity,
        open: saved?.open ?? 0,
        prevLtp: 0,
        hasBrokenHighToday: false,
        hasBrokenLowToday: false,
        tradesExecutedToday: restoredTrades,
        positionClosedAt,
        isInCooldown,
        lastTickAt: now,
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
          dayHigh: saved.dayHigh ? `₹${saved.dayHigh.toFixed(2)}` : 'not saved',
          dayLow: saved.dayLow ? `₹${saved.dayLow.toFixed(2)}` : 'not saved',
          open: saved.open ? `₹${saved.open.toFixed(2)}` : 'not saved',
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

    // Set opening price AND initialize high/low on first data point.
    // data.high/data.low are the exchange's running day high/low — they include every
    // trade since 9:15 AM, so a mid-session restart automatically picks up the correct
    // full-day range from the very first tick.
    if (state.open === 0) {
      state.open = data.open || data.ltp;
      state.dayHigh = data.high;
      state.dayLow  = data.low;
      state.prevLtp = data.ltp;
      state.lastTickAt = Date.now();
      logger.info(`📊 [${data.symbol}] Day initialized from first tick`, {
        open: `₹${state.open.toFixed(2)}`,
        dayHigh: `₹${state.dayHigh.toFixed(2)}`,
        dayLow: `₹${state.dayLow.toFixed(2)}`,
        ltp: `₹${data.ltp.toFixed(2)}`,
      });
    }

    // Track tick arrival for circuit breaker detection (price can be flat; ticks stop only on halt)
    state.lastTickAt = Date.now();

    // Cache previous levels BEFORE update
    const prevDayHigh = state.dayHigh;
    const prevDayLow = state.dayLow;

    this.checkForBreakout(data, state, prevDayHigh, prevDayLow);

    // Keep range in sync with exchange running day high/low.
    state.dayHigh = Math.max(state.dayHigh, data.high);
    state.dayLow  = Math.min(state.dayLow,  data.low);

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
      state.lastTickAt = Date.now();
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
      dayHigh: state.dayHigh > 0 ? state.dayHigh : undefined,
      dayLow: state.dayLow !== Infinity ? state.dayLow : undefined,
      open: state.open > 0 ? state.open : undefined,
    });
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

      const adx = this.cachedADXs.get(data.symbol);
      const rsi = this.cachedRSIs.get(data.symbol);
      const trend = this.cachedTrends.get(data.symbol) ?? 'NEUTRAL';

      logger.info(`📊 [${this.name}] [${data.symbol}] Price Levels Check`, {
        strategy: this.name,
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
        indicators: {
          trend,
          adx: adx !== undefined ? adx.toFixed(1) : 'loading',
          rsi: rsi !== undefined ? rsi.toFixed(1) : 'loading',
          volRatio: volRatio !== undefined ? `${volRatio.toFixed(2)}x` : 'loading',
        },
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

    // Time window guard:
    //   Before 09:45 — range is too narrow after gap open; false breakouts are common.
    //   After  15:00 — not enough session time left to reach target.
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const currentTime = `${String(istNow.getHours()).padStart(2, '0')}:${String(istNow.getMinutes()).padStart(2, '0')}`;
    if (currentTime < '09:45' || currentTime >= '15:00') {
      return;
    }

    // SHOULD FIX #11 — Circuit breaker guard: if price has not moved in 3+ minutes,
    // the stock is likely halted. Skip signals to avoid acting on stale data.
    const CIRCUIT_FREEZE_MS = 3 * 60 * 1000;
    if (Date.now() - state.lastTickAt > CIRCUIT_FREEZE_MS) {
      logger.warn(`[${this.name}] ⛔ [${data.symbol}] Price frozen 3+ min — possible circuit breaker, skipping signal`);
      return;
    }

    const ltp = data.ltp;
    const prevLtp = state.prevLtp;
    const trend = this.cachedTrends.get(data.symbol) ?? 'NEUTRAL';
    const rsi = this.cachedRSIs.get(data.symbol);
    const adx = this.cachedADXs.get(data.symbol);

    // ADX regime filter: skip signals in choppy/ranging markets
    // Threshold 15 is appropriate for 5-min intraday (20 is calibrated for daily charts)
    if (adx !== undefined && adx < 7) {
      logger.info(`[${this.name}] 🚫 [${data.symbol}] Signal blocked — ADX=${adx.toFixed(1)}<7 (choppy market)`);
      return;
    }

    const crossedAboveHigh = prevLtp <= dayHigh && ltp > dayHigh;
    const crossedBelowLow = prevLtp >= dayLow && ltp < dayLow;

    // Log every cross event — whether it fires or is silently blocked
    if (crossedAboveHigh) {
      logger.info(`[${this.name}] 🔔 [${data.symbol}] HIGH cross detected`, {
        prevLtp: prevLtp.toFixed(2), ltp: ltp.toFixed(2), dayHigh: dayHigh.toFixed(2),
        hasBrokenHighToday: state.hasBrokenHighToday, trend,
        adx: adx?.toFixed(1) ?? 'N/A',
        rsi: rsi?.toFixed(1) ?? 'N/A',
        vol: `${(this.cachedVolumeRatios.get(data.symbol) ?? 0).toFixed(2)}x`,
      });
    }
    if (crossedBelowLow) {
      logger.info(`[${this.name}] 🔔 [${data.symbol}] LOW cross detected`, {
        prevLtp: prevLtp.toFixed(2), ltp: ltp.toFixed(2), dayLow: dayLow.toFixed(2),
        hasBrokenLowToday: state.hasBrokenLowToday, trend,
        adx: adx?.toFixed(1) ?? 'N/A',
        rsi: rsi?.toFixed(1) ?? 'N/A',
        vol: `${(this.cachedVolumeRatios.get(data.symbol) ?? 0).toFixed(2)}x`,
      });
    }

    if (crossedAboveHigh && !state.hasBrokenHighToday) {
      const volRatio = this.cachedVolumeRatios.get(data.symbol) ?? 0;
      if (volRatio < 0.5) {
        logger.info(`[${this.name}] 🚫 [${data.symbol}] BUY breakout rejected — volume ${volRatio.toFixed(2)}x < 0.5x`);
        return;
      }

      if (rsi !== undefined && rsi >= 70) {
        logger.info(`[${this.name}] 🚫 [${data.symbol}] BUY breakout rejected — RSI overbought (${rsi.toFixed(1)})`);
        return;
      }

      state.hasBrokenHighToday = true;
      state.tradesExecutedToday++;
      this.saveSymbolState(data.symbol, state);
      this.on_buy_signal(data.symbol, ltp, dayHigh, prevLtp, this.cachedATRs.get(data.symbol));
      return;
    }

    if (crossedBelowLow && !state.hasBrokenLowToday) {
      const volRatio = this.cachedVolumeRatios.get(data.symbol) ?? 0;
      if (volRatio < 0.5) {
        logger.info(`[${this.name}] 🚫 [${data.symbol}] SELL breakout rejected — volume ${volRatio.toFixed(2)}x < 0.5x`);
        return;
      }

      if (rsi !== undefined && rsi <= 30) {
        logger.info(`[${this.name}] 🚫 [${data.symbol}] SELL breakout rejected — RSI oversold (${rsi.toFixed(1)})`);
        return;
      }

      state.hasBrokenLowToday = true;
      state.tradesExecutedToday++;
      this.saveSymbolState(data.symbol, state);
      this.on_sell_signal(data.symbol, ltp, dayLow, prevLtp, this.cachedATRs.get(data.symbol));
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
    const stopLoss = atr ? ltp - atr : ltp * (1 - 0.0025);
    const target = atr ? ltp + atr * 2 : ltp * (1 + 0.005);

    // Get symbol-specific margin multiplier
    const marginMultiplier = getSymbolMarginMultiplier(symbol);

    const signal: StrategySignal = {
      symbol,
      action: "BUY",
      stopLoss,
      target,
      marginMultiplier,
      useTrailingSL: true,
      signalPrice: ltp,
      reason: `Crossed ABOVE day high at ₹${ltp.toFixed(2)} (Day High: ₹${dayHigh.toFixed(2)}, ATR: ${atr ? `₹${atr.toFixed(2)}` : 'fixed'})`,
      confidence: 0.8,
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
    const stopLoss = atr ? ltp + atr : ltp * (1 + 0.0025);
    const target = atr ? ltp - atr * 2 : ltp * (1 - 0.005);

    // Get symbol-specific margin multiplier
    const marginMultiplier = getSymbolMarginMultiplier(symbol);

    const signal: StrategySignal = {
      symbol,
      action: "SELL",
      stopLoss,
      target,
      marginMultiplier,
      useTrailingSL: true,
      signalPrice: ltp,
      reason: `Crossed BELOW day low at ₹${ltp.toFixed(2)} (Day Low: ₹${dayLow.toFixed(2)}, ATR: ${atr ? `₹${atr.toFixed(2)}` : 'fixed'})`,
      confidence: 0.8,
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

    // Session volume ratio: just-closed candle vs average of all today's closed candles.
    if (fiveMin.length >= 2) {
      const closedCandles = fiveMin.slice(0, -1);
      this.cachedVolumeRatios.set(symbol, sessionVolumeRatio(closedCandles));
    }

    // ATR(14) from 5-min candles — exclude the live (still-forming) candle
    if (fiveMin.length >= 16) {
      const atr = calculateATR(fiveMin.slice(0, -1), 14);
      if (atr) this.cachedATRs.set(symbol, atr);
    }

    // RSI(14) from 5-min closes — exclude the live candle
    if (fiveMin.length >= 16) {
      const closes = fiveMin.slice(0, -1).map(c => c.close);
      const rsi = calculateRSI(closes, 14);
      if (rsi !== null) this.cachedRSIs.set(symbol, rsi);
    }

    // 30-min trend direction for the breakout gate
    this.cachedTrends.set(symbol, get30MinTrend(thirtyMin));

    // ADX(7) from 5-min candles — period 7 gives ~20 min lag vs 50 min for period 14,
    // which is appropriate for intraday breakouts on 5-min charts.
    if (fiveMin.length >= 15) {
      const adx = calculateADX(fiveMin.slice(0, -1), 7);
      if (adx !== null) this.cachedADXs.set(symbol, adx);
    }
  }

  public onPositionUpdate(position: Position): void {
    const state = this.symbolStates.get(position.symbol);
    if (!state) return;

    if (position.quantity === 0) {
      // Position closed - start 10-minute cooldown
      state.positionClosedAt = Date.now();
      state.isInCooldown = true;

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
        lastTickAt: Date.now(),
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

  public getMarketSnapshot(): Array<{
    symbol: string;
    ltp: number;
    open: number;
    dayHigh: number;
    dayLow: number;
    distToHigh: number;
    distToLow: number;
    trend: string;
    adx: number | undefined;
    rsi: number | undefined;
    volRatio: number | undefined;
    isInCooldown: boolean;
    tradesExecutedToday: number;
  }> {
    const result = [];
    for (const [symbol, state] of this.symbolStates.entries()) {
      if (state.prevLtp === 0 && state.dayHigh === 0) continue; // not yet initialized
      const ltp = state.prevLtp;
      const distToHigh = state.dayHigh > 0 ? ((state.dayHigh - ltp) / ltp) * 100 : 0;
      const distToLow = state.dayLow !== Infinity ? ((ltp - state.dayLow) / ltp) * 100 : 0;
      result.push({
        symbol,
        ltp,
        open: state.open,
        dayHigh: state.dayHigh,
        dayLow: state.dayLow === Infinity ? 0 : state.dayLow,
        distToHigh,
        distToLow,
        trend: this.cachedTrends.get(symbol) ?? 'NEUTRAL',
        adx: this.cachedADXs.get(symbol),
        rsi: this.cachedRSIs.get(symbol),
        volRatio: this.cachedVolumeRatios.get(symbol),
        isInCooldown: state.isInCooldown,
        tradesExecutedToday: state.tradesExecutedToday,
      });
    }
    // Sort: nearest to breakout first (min of distToHigh, distToLow)
    result.sort((a, b) => Math.min(a.distToHigh, a.distToLow) - Math.min(b.distToHigh, b.distToLow));
    return result;
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
      state.lastTickAt = Date.now();
      state.lastLogTime = 0;
      state.lastResetDate = today;
    }

    // Reset cached candle-derived values for the new day
    this.cachedVolumeRatios.clear();
    this.cachedATRs.clear();
    this.cachedTrends.clear();
    this.cachedRSIs.clear();
    this.cachedADXs.clear();

    logger.info("Daily data reset for all symbols");
    logger.audit("STRATEGY_DAILY_RESET", { strategy: this.name });
  }
}
