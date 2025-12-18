import { BaseStrategy } from './base';
import { StrategyContext, MarketData, StrategySignal, Position } from '../types';
import { logger } from '../utils/logger';

interface SymbolState {
  // Current day OHLC
  dayHigh: number;
  dayLow: number;
  open: number;

  // PREVIOUS day's high/low for breakout detection
  previousDayHigh: number;
  previousDayLow: number;

  lastLTP: number;  // Track previous LTP to detect breakouts
  breakoutDetected: boolean;
  breakoutDirection: 'UP' | 'DOWN' | null;
  lastLogTime: number;  // Track last log time for periodic logging
  lastResetDate: string;  // Track when we last reset for new day
}

export class DayHighLowBreakoutStrategy extends BaseStrategy {
  private symbolStates: Map<string, SymbolState> = new Map();
  private watchlist: string[] = [];
  private readonly LOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes in milliseconds

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
        previousDayHigh: 0,
        previousDayLow: Infinity,
        lastLTP: 0,
        breakoutDetected: false,
        breakoutDirection: null,
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

    // Check if it's a new trading day and reset accordingly
    this.checkAndResetForNewDay(state);

    // Set opening price on first data point
    if (state.open === 0) {
      state.open = data.open;
      logger.info(`📊 [${data.symbol}] Opening price set`, {
        open: `₹${data.open.toFixed(2)}`
      });
    }

    // Check for breakout FIRST using PREVIOUS day's high/low
    this.checkForBreakout(data, state);

    // THEN update current day's high/low AFTER checking
    state.dayHigh = Math.max(state.dayHigh, data.high);
    state.dayLow = Math.min(state.dayLow, data.low);

    // Log price levels every 5 minutes
    this.logPriceLevels(data, state);

    // Track last LTP for next breakout check
    state.lastLTP = data.ltp;
  }

  /**
   * Check if it's a new trading day and reset state accordingly
   */
  private checkAndResetForNewDay(state: SymbolState): void {
    const today = new Date().toISOString().split('T')[0];

    if (state.lastResetDate !== today) {
      // Save current day's high/low as previous day's before resetting
      if (state.dayHigh > 0) {
        state.previousDayHigh = state.dayHigh;
      }
      if (state.dayLow !== Infinity) {
        state.previousDayLow = state.dayLow;
      }

      // Reset current day's data
      state.dayHigh = 0;
      state.dayLow = Infinity;
      state.open = 0;
      state.breakoutDetected = false;
      state.breakoutDirection = null;
      state.lastResetDate = today;

      logger.info(`🔄 New trading day - state reset`, {
        date: today,
        previousDayHigh: state.previousDayHigh > 0 ? `₹${state.previousDayHigh.toFixed(2)}` : 'N/A',
        previousDayLow: state.previousDayLow !== Infinity ? `₹${state.previousDayLow.toFixed(2)}` : 'N/A'
      });
    }
  }

  private logPriceLevels(data: MarketData, state: SymbolState): void {
    const now = Date.now();

    // Log every 5 minutes OR on first data point
    if (state.lastLogTime === 0 || (now - state.lastLogTime) >= this.LOG_INTERVAL_MS) {
      state.lastLogTime = now;

      const distanceToHigh = ((state.dayHigh - data.ltp) / data.ltp) * 100;
      const distanceToLow = ((data.ltp - state.dayLow) / data.ltp) * 100;

      // Determine status
      let status = '⏸️  Consolidating';
      if (distanceToHigh < 0.1) {
        status = '🔥 Near High Breakout!';
      } else if (distanceToLow < 0.1) {
        status = '❄️  Near Low Breakout!';
      }

      logger.info(`📊 [${data.symbol}] Price Levels Check`, {
        symbol: data.symbol,
        status: status,
        currentPrice: `₹${data.ltp.toFixed(2)}`,
        dayHigh: `₹${state.dayHigh.toFixed(2)}`,
        dayLow: `₹${state.dayLow.toFixed(2)}`,
        open: `₹${state.open.toFixed(2)}`,
        distanceToHigh: `${distanceToHigh.toFixed(2)}%`,
        distanceToLow: `${distanceToLow.toFixed(2)}%`,
        breakoutDetected: state.breakoutDetected,
        direction: state.breakoutDirection || 'None',
        timestamp: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
      });
    }
  }

  private checkForBreakout(data: MarketData, state: SymbolState): void {
    if (state.breakoutDetected) {
      return;
    }

    const existingPosition = this.context.positions.get(data.symbol);
    if (existingPosition) {
      return;
    }

    // Can't check breakout without previous day's data
    if (state.previousDayHigh === 0 || state.previousDayLow === Infinity) {
      return;
    }

    // Breakout logic: LTP crossed the PREVIOUS day high/low with confirmation
    const breakoutThreshold = 0.001; // 0.1% above/below for confirmation
    const highBreakout = data.ltp > (state.previousDayHigh * (1 + breakoutThreshold));
    const lowBreakout = data.ltp < (state.previousDayLow * (1 - breakoutThreshold));

    // Calculate volume-based confirmation (if volume data available)
    // For now, we'll add momentum confirmation
    const priceChangePercent = ((data.ltp - state.open) / state.open) * 100;
    const hasMomentum = Math.abs(priceChangePercent) > 0.5; // At least 0.5% move from open

    if (highBreakout && hasMomentum) {
      state.breakoutDetected = true;
      state.breakoutDirection = 'UP';

      // BUY: Stop Loss 0.5% below entry, Target 0.25% above entry
      const stopLoss = data.ltp * (1 - 0.005); // 0.5% below
      const target = data.ltp * (1 + 0.0025);  // 0.25% above

      const signal: StrategySignal = {
        symbol: data.symbol,
        action: 'BUY',
        stopLoss: stopLoss,
        target: target,
        reason: `Day high breakout at ${data.ltp.toFixed(2)} (DayHigh: ${state.dayHigh.toFixed(2)})`,
        confidence: 0.7
      };

      const riskPerShare = data.ltp - stopLoss;
      const rewardPerShare = target - data.ltp;
      const riskRewardRatio = rewardPerShare / riskPerShare;

      logger.info('🚀 HIGH BREAKOUT DETECTED! Signal generated (UP)', {
        symbol: data.symbol,
        breakoutPrice: `₹${data.ltp.toFixed(2)}`,
        previousDayHigh: `₹${state.previousDayHigh.toFixed(2)}`,
        currentDayHigh: `₹${state.dayHigh.toFixed(2)}`,
        open: `₹${state.open.toFixed(2)}`,
        momentum: `${priceChangePercent.toFixed(2)}%`,
        stopLoss: `₹${stopLoss.toFixed(2)} (0.5% below entry)`,
        target: `₹${target.toFixed(2)} (1.5% above entry)`,
        riskReward: `1:${riskRewardRatio.toFixed(2)}`,
        breakoutConfirmation: `${((data.ltp - state.previousDayHigh) / state.previousDayHigh * 100).toFixed(2)}% above previous day high`
      });

      logger.audit('STRATEGY_SIGNAL', {
        strategy: this.name,
        signal
      });

      this.emitSignal(signal);
    } else if (lowBreakout && hasMomentum) {
      state.breakoutDetected = true;
      state.breakoutDirection = 'DOWN';

      // SELL: Stop Loss 0.5% above entry, Target 1.5% below entry (1:3 risk/reward)
      const stopLoss = data.ltp * (1 + 0.005); // 0.5% above
      const target = data.ltp * (1 - 0.015);  // 1.5% below

      const signal: StrategySignal = {
        symbol: data.symbol,
        action: 'SELL',
        stopLoss: stopLoss,
        target: target,
        reason: `Day low breakout at ${data.ltp.toFixed(2)} (DayLow: ${state.dayLow.toFixed(2)})`,
        confidence: 0.7
      };

      const riskPerShare = stopLoss - data.ltp;
      const rewardPerShare = data.ltp - target;
      const riskRewardRatio = rewardPerShare / riskPerShare;

      logger.info('📉 LOW BREAKOUT DETECTED! Signal generated (DOWN)', {
        symbol: data.symbol,
        breakoutPrice: `₹${data.ltp.toFixed(2)}`,
        previousDayLow: `₹${state.previousDayLow.toFixed(2)}`,
        currentDayLow: `₹${state.dayLow.toFixed(2)}`,
        open: `₹${state.open.toFixed(2)}`,
        momentum: `${priceChangePercent.toFixed(2)}%`,
        stopLoss: `₹${stopLoss.toFixed(2)} (0.5% above entry)`,
        target: `₹${target.toFixed(2)} (1.5% below entry)`,
        riskReward: `1:${riskRewardRatio.toFixed(2)}`,
        breakoutConfirmation: `${((state.previousDayLow - data.ltp) / state.previousDayLow * 100).toFixed(2)}% below previous day low`
      });

      logger.audit('STRATEGY_SIGNAL', {
        strategy: this.name,
        signal
      });

      this.emitSignal(signal);
    }
  }

  public onPositionUpdate(position: Position): void {
    const state = this.symbolStates.get(position.symbol);
    if (!state) return;

    if (position.quantity === 0) {
      state.breakoutDetected = false;
      state.breakoutDirection = null;
      logger.debug('Position closed, resetting breakout state', { symbol: position.symbol });
    }
  }

  public addSymbol(symbol: string): void {
    if (!this.symbolStates.has(symbol)) {
      this.watchlist.push(symbol);
      this.symbolStates.set(symbol, {
        dayHigh: 0,
        dayLow: Infinity,
        open: 0,
        previousDayHigh: 0,
        previousDayLow: Infinity,
        lastLTP: 0,
        breakoutDetected: false,
        breakoutDirection: null,
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
      // Save current day's high/low as previous day's before resetting
      if (state.dayHigh > 0) {
        state.previousDayHigh = state.dayHigh;
      }
      if (state.dayLow !== Infinity) {
        state.previousDayLow = state.dayLow;
      }

      // Reset current day's data
      state.dayHigh = 0;
      state.dayLow = Infinity;
      state.open = 0;
      state.lastLTP = 0;
      state.breakoutDetected = false;
      state.breakoutDirection = null;
      state.lastLogTime = 0;
      state.lastResetDate = today;
    }

    logger.info('Daily data reset for all symbols');
    logger.audit('STRATEGY_DAILY_RESET', { strategy: this.name });
  }
}
