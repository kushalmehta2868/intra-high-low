import { BaseStrategy } from './base';
import { StrategyContext, StrategySignal, MarketData, Position, Candle } from '../types';
import { CandleBundle } from '../services/candleDataService';
import { calculateEMA, calculateATR, calculateRSI, calculateADX, get30MinTrend, sessionVolumeRatio } from '../utils/indicators';
import { getSymbolMarginMultiplier } from '../config/symbolConfig';
import { logger } from '../utils/logger';

interface DayState {
  tradesExecutedToday: number;
  lastResetDate: string;
  /** Prevent re-firing the same crossover repeatedly until it resets */
  lastCrossoverDirection: 'BUY' | 'SELL' | null;
}

export interface EMACrossoverSnapshot {
  symbol: string;
  trend: string;
  adx: number | undefined;
  ema9: number | undefined;
  ema21: number | undefined;
  emaGapPct: number | undefined; // (ema9 - ema21) / ema21 * 100
  volRatio: number | undefined;
  crossover: 'BUY' | 'SELL' | 'NONE';
  tradesExecutedToday: number;
}

/**
 * EMACrossoverStrategy
 *
 * Detects EMA 9 / EMA 21 crossovers on 5-min candles with:
 *   • Volume confirmation      (current candle > 1.5× 20-bar average)
 *   • 30-min EMA(21) trend filter
 *   • ATR(14)-based SL & TP  (SL = 1.5×ATR, TP = 3×ATR → 1:2 RR)
 *
 * Confidence scoring (base 0.75):
 *   +0.05  trend aligned
 *   +0.05  volume ≥ 2× average
 *   +0.05  EMA9 slope > 0.05% between last two values (momentum)
 * Max: 0.90
 *
 * Called by CandleDataService via handleCandleUpdate() — NOT tick-based.
 */
export class EMACrossoverStrategy extends BaseStrategy {
  private readonly MAX_TRADES_PER_STOCK_PER_DAY = 2;
  private dayStates: Map<string, DayState> = new Map();
  private watchlist: string[];
  private snapshots: Map<string, EMACrossoverSnapshot> = new Map();

  constructor(context: StrategyContext, watchlist: string[]) {
    super('EMACrossover', context);
    this.watchlist = watchlist;
  }

  public async initialize(): Promise<void> {
    await super.initialize();
    const today = this.todayIST();
    for (const symbol of this.watchlist) {
      this.dayStates.set(symbol, {
        tradesExecutedToday: 0,
        lastResetDate: today,
        lastCrossoverDirection: null,
      });
    }
    logger.info('EMACrossoverStrategy initialized', { watchlist: this.watchlist.length });
  }

  public handleCandleUpdate(symbol: string, bundle: CandleBundle, ltp: number): void {
    if (!this.isActive) return;

    const position = this.context.positions.get(symbol);
    if (position && position.quantity !== 0) return;

    const state = this.getOrCreateState(symbol);
    this.resetIfNewDay(state);
    if (state.tradesExecutedToday >= this.MAX_TRADES_PER_STOCK_PER_DAY) return;

    // Skip opening volatility window and end-of-day
    if (this.isBeforeSignalStart()) return;
    if (this.isAfterMarketCutoff()) return;

    const { fiveMin, thirtyMin } = bundle;

    // Need ≥ 22 candles to compute EMA21 with at least 2 output values for crossover
    if (fiveMin.length < 23) return;

    // Use closed candles only: last element is still-forming, second-to-last is last confirmed
    const closedCandles = fiveMin.slice(0, -1);
    const closedCloses = closedCandles.map((c: Candle) => c.close);

    // EMAs must use only closed candles — live candle is partial and skews the values
    const ema9   = calculateEMA(closedCloses, 9);
    const ema21  = calculateEMA(closedCloses, 21);

    if (ema9.length < 2 || ema21.length < 2) return;

    // Align tail indices: ema21 is shorter, so compare the last two values of each
    const ema9Prev  = ema9[ema9.length - 2];
    const ema9Last  = ema9[ema9.length - 1];
    const ema21Prev = ema21[ema21.length - 2];
    const ema21Last = ema21[ema21.length - 1];

    const emaGapPct = ema21Last > 0 ? ((ema9Last - ema21Last) / ema21Last) * 100 : undefined;

    const trend    = get30MinTrend(thirtyMin);
    const atr      = calculateATR(closedCandles, 14);
    // Session volume ratio: last closed candle vs today's session average
    const lastClosed = closedCandles[closedCandles.length - 1];
    const volRatio   = sessionVolumeRatio(closedCandles);

    let adxValue: number | undefined;
    if (fiveMin.length >= 30) {
      // Need closedCandles.length >= 29 = period*2+1 for ADX(14)
      const adx = calculateADX(closedCandles, 14);
      if (adx !== null) adxValue = adx;
    }

    const bullishCross = ema9Prev <= ema21Prev && ema9Last > ema21Last;
    const bearishCross = ema9Prev >= ema21Prev && ema9Last < ema21Last;

    if (!bullishCross && !bearishCross) {
      // No new crossover — reset the directional lock so future crosses fire
      state.lastCrossoverDirection = null;
      this.snapshots.set(symbol, {
        symbol, trend, adx: adxValue, ema9: ema9Last, ema21: ema21Last,
        emaGapPct, volRatio, crossover: 'NONE', tradesExecutedToday: state.tradesExecutedToday,
      });
      return;
    }

    const crossDirection: 'BUY' | 'SELL' = bullishCross ? 'BUY' : 'SELL';

    // Record snapshot with current crossover direction
    this.snapshots.set(symbol, {
      symbol, trend, adx: adxValue, ema9: ema9Last, ema21: ema21Last,
      emaGapPct, volRatio, crossover: crossDirection, tradesExecutedToday: state.tradesExecutedToday,
    });

    // Prevent re-firing the same crossover on the next refresh before it reverses
    if (state.lastCrossoverDirection === crossDirection) return;

    if (!atr || atr === 0) return;

    // ADX regime filter: skip crossovers in choppy/ranging markets
    if (adxValue !== undefined && adxValue < 20) {
      logger.info(`[EMACrossover] ${crossDirection} cross on ${symbol} — ADX=${adxValue.toFixed(1)}<20, choppy market`);
      return;
    }

    // Trend must be aligned
    if (crossDirection === 'BUY'  && trend !== 'UP')  return;
    if (crossDirection === 'SELL' && trend !== 'DOWN') return;

    // Volume must confirm (1.3× minimum)
    if (volRatio > 0 && volRatio < 1.3) {
      logger.info(`[EMACrossover] ${crossDirection} cross on ${symbol} — volume too low (${volRatio.toFixed(2)}x < 1.3x)`);
      return;
    }

    // RSI gate: avoid buying overbought (≥70) or selling oversold (≤30)
    const rsi = calculateRSI(closedCloses, 14);
    if (rsi !== null) {
      if (crossDirection === 'BUY' && rsi >= 70) {
        logger.info(`[EMACrossover] BUY cross on ${symbol} rejected — RSI overbought (${rsi.toFixed(1)})`);
        return;
      }
      if (crossDirection === 'SELL' && rsi <= 30) {
        logger.info(`[EMACrossover] SELL cross on ${symbol} rejected — RSI oversold (${rsi.toFixed(1)})`);
        return;
      }
    }

    const ema9Slope = Math.abs((ema9Last - ema9Prev) / ema9Prev) * 100; // %
    const confidence = this.scoreConfidence(crossDirection, trend, volRatio, ema9Slope);

    state.lastCrossoverDirection = crossDirection;
    this.emitCrossSignal(symbol, crossDirection, ltp || closedCloses[closedCloses.length - 1], atr, confidence, state);
  }

  // ---------------------------------------------------------------------------

  private emitCrossSignal(
    symbol: string,
    action: 'BUY' | 'SELL',
    price: number,
    atr: number,
    confidence: number,
    state: DayState,
  ): void {
    const slDist = atr * 1.5;
    const tpDist = atr * 3.0;

    const sl     = action === 'BUY' ? price - slDist : price + slDist;
    const target = action === 'BUY' ? price + tpDist : price - tpDist;

    const signal: StrategySignal = {
      symbol,
      action,
      stopLoss: sl,
      target,
      marginMultiplier: getSymbolMarginMultiplier(symbol),
      useTrailingSL: true,
      reason: `EMA9/21 ${action} cross | ATR=${atr.toFixed(2)} | SL=${sl.toFixed(2)} | TP=${target.toFixed(2)}`,
      confidence,
    };

    state.tradesExecutedToday++;

    logger.info(`[EMACrossover] ${action} signal`, {
      symbol,
      price: price.toFixed(2),
      sl: sl.toFixed(2),
      target: target.toFixed(2),
      confidence: confidence.toFixed(2),
      tradesUsed: `${state.tradesExecutedToday}/${this.MAX_TRADES_PER_STOCK_PER_DAY}`,
    });
    logger.audit('STRATEGY_SIGNAL', { strategy: this.name, signal });

    this.emitSignal(signal);
  }

  private scoreConfidence(
    action: 'BUY' | 'SELL',
    trend: string,
    volRatio: number,
    ema9SlopePct: number,
  ): number {
    let score = 0.75;

    if ((action === 'BUY' && trend === 'UP') || (action === 'SELL' && trend === 'DOWN')) {
      score += 0.05;
    }
    if (volRatio >= 1.5)      score += 0.05;
    if (ema9SlopePct >= 0.05) score += 0.05;

    return Math.min(score, 0.90);
  }

  private getOrCreateState(symbol: string): DayState {
    if (!this.dayStates.has(symbol)) {
      this.dayStates.set(symbol, {
        tradesExecutedToday: 0,
        lastResetDate: this.todayIST(),
        lastCrossoverDirection: null,
      });
    }
    return this.dayStates.get(symbol)!;
  }

  private resetIfNewDay(state: DayState): void {
    const today = this.todayIST();
    if (state.lastResetDate !== today) {
      state.tradesExecutedToday   = 0;
      state.lastResetDate         = today;
      state.lastCrossoverDirection = null;
    }
  }

  private todayIST(): string {
    return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).split(',')[0].trim();
  }

  /** Returns true after 15:00 IST — no new entries in the last 30 min of the session. */
  private isAfterMarketCutoff(): boolean {
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return istNow.getHours() >= 15;
  }

  /** Returns true before 09:30 IST — skip opening volatility window. */
  private isBeforeSignalStart(): boolean {
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return istNow.getHours() < 9 || (istNow.getHours() === 9 && istNow.getMinutes() < 30);
  }

  public getSnapshot(): EMACrossoverSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  // IStrategy mandatory overrides (candle-driven — no action on tick)
  public onMarketData(_data: MarketData): void {}
  public onPositionUpdate(_position: Position): void {}
}
