import { BaseStrategy } from './base';
import { StrategyContext, MarketData, StrategySignal, Position } from '../types';
import { logger } from '../utils/logger';

interface SymbolState {
  dayHigh: number;
  dayLow: number;
  open: number;
  lastLTP: number;  // Track previous LTP to detect breakouts
  breakoutDetected: boolean;
  breakoutDirection: 'UP' | 'DOWN' | null;
  lastLogTime: number;  // Track last log time for periodic logging
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
        lastLTP: 0,
        breakoutDetected: false,
        breakoutDirection: null,
        lastLogTime: 0
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

    if (state.open === 0) {
      state.open = data.open;
    }

    // Check for breakout FIRST using current state.dayHigh/dayLow
    this.checkForBreakout(data, state, state.dayHigh, state.dayLow);

    // THEN update day high/low AFTER checking
    state.dayHigh = Math.max(state.dayHigh, data.high);
    state.dayLow = Math.min(state.dayLow, data.low);

    // Log price levels every 5 minutes
    this.logPriceLevels(data, state);

    // Track last LTP for next breakout check
    state.lastLTP = data.ltp;
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

  private checkForBreakout(data: MarketData, state: SymbolState, previousDayHigh: number, previousDayLow: number): void {
    if (state.breakoutDetected) {
      return;
    }

    const existingPosition = this.context.positions.get(data.symbol);
    if (existingPosition) {
      return;
    }

    // Simple breakout logic: LTP crossed the PREVIOUS day high/low
    const highBreakout = data.ltp > previousDayHigh && previousDayHigh > 0;
    const lowBreakout = data.ltp < previousDayLow && previousDayLow !== Infinity;

    // Log breakout conditions for debugging
    logger.info(`🔍 [${data.symbol}] Breakout Check`, {
      symbol: data.symbol,
      currentLTP: data.ltp.toFixed(2),
      previousDayHigh: previousDayHigh.toFixed(2),
      previousDayLow: previousDayLow === Infinity ? 'Infinity' : previousDayLow.toFixed(2),
      newDayHigh: state.dayHigh.toFixed(2),
      newDayLow: state.dayLow.toFixed(2),
      highBreakoutCondition: `${data.ltp.toFixed(2)} > ${previousDayHigh.toFixed(2)}`,
      highBreakoutMet: highBreakout,
      lowBreakoutCondition: `${data.ltp.toFixed(2)} < ${previousDayLow === Infinity ? 'Infinity' : previousDayLow.toFixed(2)}`,
      lowBreakoutMet: lowBreakout
    });

    if (highBreakout) {
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
        dayHigh: `₹${state.dayHigh.toFixed(2)}`,
        dayLow: `₹${state.dayLow.toFixed(2)}`,
        open: `₹${state.open.toFixed(2)}`,
        stopLoss: `₹${stopLoss.toFixed(2)} (0.5% below entry)`,
        target: `₹${target.toFixed(2)} (0.25% above entry)`,
        riskReward: `1:${riskRewardRatio.toFixed(2)}`,
        priceMovement: `${((data.ltp - state.dayHigh) / state.dayHigh * 100).toFixed(2)}% above day high`
      });

      logger.audit('STRATEGY_SIGNAL', {
        strategy: this.name,
        signal
      });

      this.emitSignal(signal);
    } else if (lowBreakout) {
      state.breakoutDetected = true;
      state.breakoutDirection = 'DOWN';

      // SELL: Stop Loss 0.5% above entry, Target 0.25% below entry
      const stopLoss = data.ltp * (1 + 0.005); // 0.5% above
      const target = data.ltp * (1 - 0.0025);  // 0.25% below

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
        dayHigh: `₹${state.dayHigh.toFixed(2)}`,
        dayLow: `₹${state.dayLow.toFixed(2)}`,
        open: `₹${state.open.toFixed(2)}`,
        stopLoss: `₹${stopLoss.toFixed(2)} (0.5% above entry)`,
        target: `₹${target.toFixed(2)} (0.25% below entry)`,
        riskReward: `1:${riskRewardRatio.toFixed(2)}`,
        priceMovement: `${((state.dayLow - data.ltp) / state.dayLow * 100).toFixed(2)}% below day low`
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
        lastLTP: 0,
        breakoutDetected: false,
        breakoutDirection: null,
        lastLogTime: 0
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
    for (const state of this.symbolStates.values()) {
      state.dayHigh = 0;
      state.dayLow = Infinity;
      state.open = 0;
      state.lastLTP = 0;
      state.breakoutDetected = false;
      state.breakoutDirection = null;
      state.lastLogTime = 0;
    }

    logger.info('Daily data reset for all symbols');
    logger.audit('STRATEGY_DAILY_RESET', { strategy: this.name });
  }
}
