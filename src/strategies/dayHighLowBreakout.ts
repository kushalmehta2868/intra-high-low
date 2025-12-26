import { BaseStrategy } from './base';
import { StrategyContext, MarketData, StrategySignal, Position } from '../types';
import { logger } from '../utils/logger';
import { getSymbolMarginMultiplier } from '../config/symbolConfig';
import { volumeTracker } from '../services/volumeTracker';

interface SymbolState {
  // Current day OHLC
  dayHigh: number;
  dayLow: number;
  open: number;

  // Track previous LTP for cross detection
  prevLtp: number;

  // Breakout flags - ensure single signal per day
  hasBrokenHighToday: boolean;
  hasBrokenLowToday: boolean;

  // Cooldown after position close
  positionClosedAt: number | null;  // Timestamp when position was closed
  isInCooldown: boolean;            // Whether symbol is in cooldown period

  lastLogTime: number;  // Track last log time for periodic logging
  lastResetDate: string;  // Track when we last reset for new day
}

export class DayHighLowBreakoutStrategy extends BaseStrategy {
  private symbolStates: Map<string, SymbolState> = new Map();
  private watchlist: string[] = [];
  private readonly LOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes in milliseconds
  private readonly COOLDOWN_PERIOD_MS = 15 * 60 * 1000; // 15 minutes cooldown after position close

  constructor(context: StrategyContext, watchlist: string[] = []) {
    super('DayHighLowBreakout', context);
    this.watchlist = watchlist;
  }

  public async initialize(): Promise<void> {
    await super.initialize();

    for (const symbol of this.watchlist) {
      this.symbolStates.set(symbol, {
        dayHigh: 0,
        dayLow: Infinity,
        open: 0,
        prevLtp: 0,
        hasBrokenHighToday: false,
        hasBrokenLowToday: false,
        positionClosedAt: null,
        isInCooldown: false,
        lastLogTime: 0,
        lastResetDate: ''
      });
    }

    logger.info('DayHighLowBreakout strategy initialized', {
      watchlist: this.watchlist
    });
  }

  public onMarketData(data: MarketData): void {
    if (!this.isActive) return;

    const state = this.symbolStates.get(data.symbol);
    if (!state) return;

    // Update volume tracker with current tick volume
    if (data.volume) {
      volumeTracker.updateVolume(data.symbol, data.volume);
    }

    // Check if it's a new trading day and reset accordingly
    this.checkAndResetForNewDay(state);

    // Check and clear cooldown if period has elapsed
    this.checkCooldownExpiry(data.symbol, state);

    // Set opening price AND initialize high/low on first data point
    if (state.open === 0) {
      state.open = data.open || data.ltp;
      state.dayHigh = data.high || data.ltp; // Initialize from real data, not 0
      state.dayLow = data.low || data.ltp;   // Initialize from real data, not Infinity
      state.prevLtp = data.ltp;
      logger.info(`📊 [${data.symbol}] Day initialized from first tick`, {
        open: `₹${state.open.toFixed(2)}`,
        dayHigh: `₹${state.dayHigh.toFixed(2)}`,
        dayLow: `₹${state.dayLow.toFixed(2)}`,
        ltp: `₹${data.ltp.toFixed(2)}`
      });
    }

    // Cache previous levels BEFORE update
    const prevDayHigh = state.dayHigh;
    const prevDayLow = state.dayLow;

    // Detect breakout using previous levels
    this.checkForBreakout(data, state, prevDayHigh, prevDayLow);

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
    const today = new Date().toISOString().split('T')[0];

    if (state.lastResetDate !== today) {
      // Reset for new trading day
      state.dayHigh = 0;
      state.dayLow = Infinity;
      state.open = 0;
      state.prevLtp = 0;
      state.hasBrokenHighToday = false;
      state.hasBrokenLowToday = false;
      state.positionClosedAt = null;
      state.isInCooldown = false;
      state.lastResetDate = today;

      logger.info(`🔄 New trading day - state reset`, { date: today });
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
        // Cooldown period has elapsed
        state.isInCooldown = false;
        state.positionClosedAt = null;
        state.hasBrokenHighToday = false;
        state.hasBrokenLowToday = false;

        logger.info(`⏰ [${symbol}] Cooldown period ended - ready for new signals`, {
          cooldownDuration: `${(timeSinceClose / 60000).toFixed(1)} minutes`
        });
      }
    }
  }

  private logPriceLevels(data: MarketData, state: SymbolState): void {
    const now = Date.now();

    // Log every 5 minutes OR on first data point
    if (state.lastLogTime === 0 || (now - state.lastLogTime) >= this.LOG_INTERVAL_MS) {
      state.lastLogTime = now;

      const distanceToHigh = state.dayHigh > 0 ? ((state.dayHigh - data.ltp) / data.ltp) * 100 : 0;
      const distanceToLow = state.dayLow !== Infinity ? ((data.ltp - state.dayLow) / data.ltp) * 100 : 0;

      // Determine status
      let status = '⏸️  Consolidating';
      if (distanceToHigh < 0.1 && !state.hasBrokenHighToday) {
        status = '🔥 Near High Breakout!';
      } else if (distanceToLow < 0.1 && !state.hasBrokenLowToday) {
        status = '❄️  Near Low Breakout!';
      }

      logger.info(`📊 [${data.symbol}] Price Levels Check`, {
        symbol: data.symbol,
        status: status,
        currentPrice: `₹${data.ltp.toFixed(2)}`,
        dayHigh: `₹${state.dayHigh.toFixed(2)}`,
        dayLow: `₹${state.dayLow !== Infinity ? state.dayLow.toFixed(2) : 'N/A'}`,
        open: `₹${state.open.toFixed(2)}`,
        distanceToHigh: `${distanceToHigh.toFixed(2)}%`,
        distanceToLow: `${distanceToLow.toFixed(2)}%`,
        hasBrokenHigh: state.hasBrokenHighToday,
        hasBrokenLow: state.hasBrokenLowToday,
        timestamp: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
      });
    }
  }

  /**
   * Check for breakout using EXACT cross-above/cross-below logic
   * Buy: prevLtp <= dayHigh AND ltp > dayHigh (cross ABOVE current day high)
   * Sell: prevLtp >= dayLow AND ltp < dayLow (cross BELOW current day low)
   */
  private checkForBreakout(data: MarketData, state: SymbolState, dayHigh: number,
    dayLow: number): void {
    // Skip if we already have a position
    const existingPosition = this.context.positions.get(data.symbol);
    if (existingPosition && existingPosition.quantity !== 0) {
      return;
    }

    // Skip if symbol is in cooldown period
    if (state.isInCooldown) {
      return;
    }

    // Can't check cross without previous LTP or valid day high/low
    if (state.prevLtp === 0 || state.dayHigh === 0 || state.dayLow === Infinity) {
      return;
    }

    const ltp = data.ltp;
    const prevLtp = state.prevLtp;

    const crossedAboveHigh = prevLtp <= dayHigh && ltp > dayHigh;
    const crossedBelowLow = prevLtp >= dayLow && ltp < dayLow;

    if (crossedAboveHigh && !state.hasBrokenHighToday) {
      // CRITICAL: Check volume surge before generating signal
      if (!volumeTracker.hasVolumeSurge(data.symbol)) {
        logger.info(`🚫 BUY signal rejected - insufficient volume`, {
          symbol: data.symbol,
          volumeRatio: volumeTracker.getVolumeRatio(data.symbol).toFixed(2) + 'x',
          required: '1.5x'
        });
        return; // Reject signal without setting hasBrokenHighToday
      }

      state.hasBrokenHighToday = true;
      this.on_buy_signal(data.symbol, ltp, dayHigh, prevLtp);
      return;
    }

    if (crossedBelowLow && !state.hasBrokenLowToday) {
      // CRITICAL: Check volume surge before generating signal
      if (!volumeTracker.hasVolumeSurge(data.symbol)) {
        logger.info(`🚫 SELL signal rejected - insufficient volume`, {
          symbol: data.symbol,
          volumeRatio: volumeTracker.getVolumeRatio(data.symbol).toFixed(2) + 'x',
          required: '1.5x'
        });
        return; // Reject signal without setting hasBrokenLowToday
      }

      state.hasBrokenLowToday = true;
      this.on_sell_signal(data.symbol, ltp, dayLow, prevLtp);
      return;
    }
  }

  /**
   * Handle BUY signal when price crosses ABOVE day high
   */
  private on_buy_signal(symbol: string, ltp: number, dayHigh: number, prevLtp: number): void {
    // Stop Loss: 0.5% below entry
    // Target: 0.25% above entry (1:0.5 risk/reward ratio - conservative start)
    const stopLoss = ltp * (1 - 0.005); // 0.5% below
    const target = ltp * (1 + 0.0025);   // 0.25% above

    // Get symbol-specific margin multiplier
    const marginMultiplier = getSymbolMarginMultiplier(symbol);

    const signal: StrategySignal = {
      symbol,
      action: 'BUY',
      stopLoss,
      target,
      marginMultiplier,
      reason: `Crossed ABOVE day high at ₹${ltp.toFixed(2)} (Day High: ₹${dayHigh.toFixed(2)})`,
      confidence: 0.7
    };

    const riskPerShare = ltp - stopLoss;
    const rewardPerShare = target - ltp;
    const riskRewardRatio = rewardPerShare / riskPerShare;

    logger.info('🚀 BUY SIGNAL - Price crossed ABOVE day high', {
      symbol,
      prevLtp: `₹${prevLtp.toFixed(2)}`,
      dayHigh: `₹${dayHigh.toFixed(2)}`,
      currentLtp: `₹${ltp.toFixed(2)}`,
      crossConfirmation: `prevLtp (${prevLtp.toFixed(2)}) <= dayHigh (${dayHigh.toFixed(2)}) AND ltp (${ltp.toFixed(2)}) > dayHigh`,
      stopLoss: `₹${stopLoss.toFixed(2)} (0.5% below)`,
      target: `₹${target.toFixed(2)} (0.25% above)`,
      riskReward: `1:${riskRewardRatio.toFixed(2)}`
    });

    logger.audit('STRATEGY_SIGNAL', {
      strategy: this.name,
      signal
    });

    this.emitSignal(signal);
  }

  /**
   * Handle SELL signal when price crosses BELOW day low
   */
  private on_sell_signal(symbol: string, ltp: number, dayLow: number, prevLtp: number): void {
    // Stop Loss: 0.5% above entry
    // Target: 0.25% below entry (1:0.5 risk/reward ratio - conservative start)
    const stopLoss = ltp * (1 + 0.005); // 0.5% above
    const target = ltp * (1 - 0.0025);   // 0.25% below

    // Get symbol-specific margin multiplier
    const marginMultiplier = getSymbolMarginMultiplier(symbol);

    const signal: StrategySignal = {
      symbol,
      action: 'SELL',
      stopLoss,
      target,
      marginMultiplier,
      reason: `Crossed BELOW day low at ₹${ltp.toFixed(2)} (Day Low: ₹${dayLow.toFixed(2)})`,
      confidence: 0.7
    };

    const riskPerShare = stopLoss - ltp;
    const rewardPerShare = ltp - target;
    const riskRewardRatio = rewardPerShare / riskPerShare;

    logger.info('📉 SELL SIGNAL - Price crossed BELOW day low', {
      symbol,
      prevLtp: `₹${prevLtp.toFixed(2)}`,
      dayLow: `₹${dayLow.toFixed(2)}`,
      currentLtp: `₹${ltp.toFixed(2)}`,
      crossConfirmation: `prevLtp (${prevLtp.toFixed(2)}) >= dayLow (${dayLow.toFixed(2)}) AND ltp (${ltp.toFixed(2)}) < dayLow`,
      stopLoss: `₹${stopLoss.toFixed(2)} (0.5% above)`,
      target: `₹${target.toFixed(2)} (0.25% below)`,
      riskReward: `1:${riskRewardRatio.toFixed(2)}`
    });

    logger.audit('STRATEGY_SIGNAL', {
      strategy: this.name,
      signal
    });

    this.emitSignal(signal);
  }

  public onPositionUpdate(position: Position): void {
    const state = this.symbolStates.get(position.symbol);
    if (!state) return;

    if (position.quantity === 0) {
      // Position closed - start 15-minute cooldown
      state.positionClosedAt = Date.now();
      state.isInCooldown = true;

      logger.info(`🔒 [${position.symbol}] Position closed - 15-minute cooldown started`, {
        closedAt: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
        cooldownEndsAt: new Date(Date.now() + this.COOLDOWN_PERIOD_MS).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
      });
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
        positionClosedAt: null,
        isInCooldown: false,
        lastLogTime: 0,
        lastResetDate: ''
      });

      logger.info('Symbol added to strategy watchlist', { symbol });
    }
  }

  public removeSymbol(symbol: string): void {
    this.symbolStates.delete(symbol);
    this.watchlist = this.watchlist.filter(s => s !== symbol);
    logger.info('Symbol removed from strategy watchlist', { symbol });
  }

  public getWatchlist(): string[] {
    return [...this.watchlist];
  }

  public resetDailyData(): void {
    const today = new Date().toISOString().split('T')[0];

    for (const state of this.symbolStates.values()) {
      // Reset current day's data
      state.dayHigh = 0;
      state.dayLow = Infinity;
      state.open = 0;
      state.prevLtp = 0;
      state.hasBrokenHighToday = false;
      state.hasBrokenLowToday = false;
      state.positionClosedAt = null;
      state.isInCooldown = false;
      state.lastLogTime = 0;
      state.lastResetDate = today;
    }

    // Reset volume tracker for new day
    volumeTracker.resetSessionVolume();

    logger.info('Daily data reset for all symbols');
    logger.audit('STRATEGY_DAILY_RESET', { strategy: this.name });
  }
}
