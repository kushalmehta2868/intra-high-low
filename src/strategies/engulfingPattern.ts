import { BaseStrategy } from './base';
import { StrategyContext, StrategySignal, MarketData, Position } from '../types';
import { CandleBundle } from '../services/candleDataService';
import { calculateATR, calculateRSI, calculateADX, get30MinTrend, avgVolume } from '../utils/indicators';
import { getSymbolMarginMultiplier } from '../config/symbolConfig';
import { logger } from '../utils/logger';

interface DayState {
  tradesExecutedToday: number;
  lastResetDate: string;
}

export interface EngulfingSnapshot {
  symbol: string;
  trend: string;
  adx: number | undefined;
  volRatio: number | undefined;
  lastPattern: 'BULLISH' | 'BEARISH' | 'NONE';
  tradesExecutedToday: number;
}

/**
 * EngulfingPatternStrategy
 *
 * Detects 10-min bullish / bearish engulfing candles with:
 *   • 30-min EMA(21) trend filter  (must be aligned to signal direction)
 *   • Volume confirmation           (current candle > 1.5× 20-bar average)
 *   • ATR(14)-based SL & TP        (SL = 1×ATR, TP = 2×ATR)
 *
 * Confidence scoring (base 0.75):
 *   +0.05  trend aligned
 *   +0.05  candle body ≥ 60% of candle range (strong engulf)
 *   +0.05  volume ≥ 2× average
 * Max: 0.90
 *
 * Called by CandleDataService via handleCandleUpdate() — NOT tick-based.
 */
export class EngulfingPatternStrategy extends BaseStrategy {
  private readonly MAX_TRADES_PER_STOCK_PER_DAY = 2;
  private dayStates: Map<string, DayState> = new Map();
  private watchlist: string[];
  private snapshots: Map<string, EngulfingSnapshot> = new Map();

  constructor(context: StrategyContext, watchlist: string[]) {
    super('EngulfingPattern', context);
    this.watchlist = watchlist;
  }

  public async initialize(): Promise<void> {
    await super.initialize();
    const today = this.todayIST();
    for (const symbol of this.watchlist) {
      this.dayStates.set(symbol, { tradesExecutedToday: 0, lastResetDate: today });
    }
    logger.info('EngulfingPatternStrategy initialized', { watchlist: this.watchlist.length });
  }

  /**
   * Called by CandleDataService after every candle refresh.
   * ltp: current live price from marketDataCache (used for logging / sizing).
   */
  public handleCandleUpdate(symbol: string, bundle: CandleBundle, ltp: number): void {
    if (!this.isActive) return;

    // Gate: must have an existing position-free slot
    const position = this.context.positions.get(symbol);
    if (position && position.quantity !== 0) return;

    const state = this.getOrCreateState(symbol);
    this.resetIfNewDay(state);
    if (state.tradesExecutedToday >= this.MAX_TRADES_PER_STOCK_PER_DAY) return;

    // No new entries after 15:00 IST — not enough time to reach target
    if (this.isAfterMarketCutoff()) return;

    const { tenMin, thirtyMin } = bundle;

    // Need: 1 live candle + 2 confirmed for engulfing + 20 for volume avg = 23 minimum
    if (tenMin.length < 23) return;

    // Use only confirmed (closed) candles: length-1 is live, length-2 is last confirmed
    const prev = tenMin[tenMin.length - 3]; // second-to-last confirmed
    const curr = tenMin[tenMin.length - 2]; // last confirmed candle

    // Skip if any OHLC value is missing / zero
    if (!prev || !curr) return;
    if ([prev.open, prev.high, prev.low, prev.close,
         curr.open, curr.high, curr.low, curr.close].some(v => !v || isNaN(v))) return;

    const trend    = get30MinTrend(thirtyMin);
    const atr      = calculateATR(tenMin.slice(0, -1), 14);
    const volAvg   = avgVolume(tenMin.slice(0, -1), 20);
    const volRatio = volAvg > 0 ? curr.volume / volAvg : 0;

    let adxValue: number | undefined;
    if (tenMin.length >= 29) {
      const adx = calculateADX(tenMin.slice(0, -1), 14);
      if (adx !== null) adxValue = adx;
    }

    if (!atr || atr === 0) return;

    // ADX regime filter
    if (adxValue !== undefined && adxValue < 20) {
      logger.debug(`[EngulfingPattern] ${symbol}: ADX=${adxValue.toFixed(1)}<20 — choppy, skipping`);
      this.snapshots.set(symbol, { symbol, trend, adx: adxValue, volRatio, lastPattern: 'NONE', tradesExecutedToday: state.tradesExecutedToday });
      return;
    }

    const isBullishEngulf =
      curr.close > curr.open &&          // current is bullish
      prev.close < prev.open &&          // previous was bearish
      curr.open  < prev.close &&         // current opens below prev close
      curr.close > prev.open;            // current closes above prev open

    const isBearishEngulf =
      curr.close < curr.open &&          // current is bearish
      prev.close > prev.open &&          // previous was bullish
      curr.open  > prev.close &&         // current opens above prev close
      curr.close < prev.open;            // current closes below prev open

    // RSI gate: avoid buying overbought (≥70) or selling oversold (≤30)
    const closes = tenMin.slice(0, -1).map(c => c.close); // confirmed candles only
    const rsi = calculateRSI(closes, 14);

    const detectedPattern: 'BULLISH' | 'BEARISH' | 'NONE' =
      isBullishEngulf ? 'BULLISH' : isBearishEngulf ? 'BEARISH' : 'NONE';
    this.snapshots.set(symbol, { symbol, trend, adx: adxValue, volRatio, lastPattern: detectedPattern, tradesExecutedToday: state.tradesExecutedToday });

    if (isBullishEngulf && trend === 'UP') {
      if (rsi !== null && rsi >= 70) {
        logger.info(`[EngulfingPattern] BUY engulf on ${symbol} rejected — RSI overbought (${rsi.toFixed(1)})`);
        return;
      }
      const confidence = this.scoreConfidence(curr, trend, 'BUY', volRatio);
      this.emitEngulfSignal(symbol, 'BUY', ltp || curr.close, atr, confidence, state);
    } else if (isBearishEngulf && trend === 'DOWN') {
      if (rsi !== null && rsi <= 30) {
        logger.info(`[EngulfingPattern] SELL engulf on ${symbol} rejected — RSI oversold (${rsi.toFixed(1)})`);
        return;
      }
      const confidence = this.scoreConfidence(curr, trend, 'SELL', volRatio);
      this.emitEngulfSignal(symbol, 'SELL', ltp || curr.close, atr, confidence, state);
    }
  }

  // ---------------------------------------------------------------------------

  private emitEngulfSignal(
    symbol: string,
    action: 'BUY' | 'SELL',
    price: number,
    atr: number,
    confidence: number,
    state: DayState,
  ): void {
    const sl     = action === 'BUY' ? price - atr       : price + atr;
    const target = action === 'BUY' ? price + atr * 2   : price - atr * 2;

    const signal: StrategySignal = {
      symbol,
      action,
      stopLoss: sl,
      target,
      marginMultiplier: getSymbolMarginMultiplier(symbol),
      useTrailingSL: false,
      reason: `Engulfing ${action} | ATR=${atr.toFixed(2)} | SL=${sl.toFixed(2)} | TP=${target.toFixed(2)}`,
      confidence,
    };

    state.tradesExecutedToday++;

    logger.info(`[EngulfingPattern] ${action} signal`, {
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

  /**
   * Confidence scoring: base 0.75, max 0.90.
   */
  private scoreConfidence(
    candle: { open: number; high: number; low: number; close: number; volume: number },
    trend: string,
    action: 'BUY' | 'SELL',
    volRatio: number,
  ): number {
    let score = 0.75;

    // Trend alignment bonus
    if ((action === 'BUY' && trend === 'UP') || (action === 'SELL' && trend === 'DOWN')) {
      score += 0.05;
    }

    // Strong engulfing body (≥ 60% of full range)
    const body  = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    if (range > 0 && body / range >= 0.6) {
      score += 0.05;
    }

    // Volume surge
    if (volRatio >= 2.0) {
      score += 0.05;
    }

    return Math.min(score, 0.90);
  }

  private getOrCreateState(symbol: string): DayState {
    if (!this.dayStates.has(symbol)) {
      this.dayStates.set(symbol, { tradesExecutedToday: 0, lastResetDate: this.todayIST() });
    }
    return this.dayStates.get(symbol)!;
  }

  private resetIfNewDay(state: DayState): void {
    const today = this.todayIST();
    if (state.lastResetDate !== today) {
      state.tradesExecutedToday = 0;
      state.lastResetDate = today;
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

  public getSnapshot(): EngulfingSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  // IStrategy mandatory overrides (not tick-based — do nothing on tick)
  public onMarketData(_data: MarketData): void {}
  public onPositionUpdate(_position: Position): void {}
}
