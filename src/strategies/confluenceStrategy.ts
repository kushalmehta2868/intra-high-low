import { BaseStrategy } from './base';
import { StrategyContext, StrategySignal, MarketData, Position, Candle } from '../types';
import { CandleBundle } from '../services/candleDataService';
import {
  calculateEMA,
  calculateATR,
  calculateRSI,
  calculateMACD,
  calculateADX,
  calculateSessionVWAP,
  sessionVolumeRatio,
} from '../utils/indicators';
import { getSymbolMarginMultiplier } from '../config/symbolConfig';
import { logger } from '../utils/logger';

// ─── Internal types ───────────────────────────────────────────────────────────

interface Vote {
  direction: 'BUY' | 'SELL' | 'NEUTRAL';
  slDist:    number | null;
  tpDist:    number | null;
  reason:    string;
}

interface DayState {
  tradesExecutedToday: number;
  lastResetDate: string;
}

export interface ConfluenceSnapshot {
  symbol: string;
  adx: number | undefined;
  s1: 'BUY' | 'SELL' | 'NEUTRAL';
  s2: 'BUY' | 'SELL' | 'NEUTRAL';
  s3: 'BUY' | 'SELL' | 'NEUTRAL';
  buyVotes: number;
  sellVotes: number;
  tradesExecutedToday: number;
}

// ─── Sub-strategies (ported from crypto-bot, adapted for NSE 5-min candles) ──

/**
 * S1 — RSI + MACD Confluence Scalping
 *   LONG:  RSI(14) < 40  AND MACD cross above signal  AND price > EMA(9)  AND vol > 20-bar MA
 *   SHORT: RSI(14) > 60  AND MACD cross below signal  AND price < EMA(9)  AND vol > 20-bar MA
 *   SL = max(1.5×ATR, 0.3% price),  TP = max(2.5×ATR, 0.6% price)
 */
function s1_rsiMacdScalp(candles: Candle[], price: number): Vote {
  const N = (r: string): Vote => ({ direction: 'NEUTRAL', slDist: null, tpDist: null, reason: r });
  if (candles.length < 40) return N('S1: need ≥40 candles');

  const closes  = candles.map(c => c.close);
  const rsi     = calculateRSI(closes, 14);
  const macd    = calculateMACD(closes);
  const ema9    = calculateEMA(closes, 9);
  const atr     = calculateATR(candles, 14);

  // Absolute volume vs 20-bar MA (matches crypto-bot — more reliable than session ratio)
  const volMA   = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  const curVol  = candles[candles.length - 1].volume;

  if (rsi === null || !macd || ema9.length < 2 || !atr) return N('S1: indicator not ready');

  const { macdLine, signalLine } = macd;
  const last = macdLine.length - 1;
  if (last < 1) return N('S1: MACD series too short');

  const crossUp = macdLine[last - 1] < signalLine[last - 1] && macdLine[last] >= signalLine[last];
  const crossDn = macdLine[last - 1] > signalLine[last - 1] && macdLine[last] <= signalLine[last];

  const latestEMA9 = ema9[ema9.length - 1];

  // SL: 1.5× ATR — prevents stop-outs from normal 5-min tick noise on NSE large-caps
  // TP: 2.5× ATR — achievable within a 6.25-hr session; 3× risks expiry at 3pm forced close
  const slDist = Math.max(atr * 1.5, price * 0.003);
  const tpDist = Math.max(atr * 2.5, price * 0.006);

  // RSI 40/60: calibrated for NSE 5-min — large-caps rarely breach 35/65 intraday,
  // so 35/65 (crypto-bot) would suppress most valid NSE signals.
  if (rsi < 40 && crossUp && price > latestEMA9 && curVol > volMA) {
    return {
      direction: 'BUY', slDist, tpDist,
      reason: `S1 BUY: RSI=${rsi.toFixed(1)}<40 MACD↑ price>EMA9 vol=${curVol.toFixed(0)}>${volMA.toFixed(0)}`,
    };
  }
  if (rsi > 60 && crossDn && price < latestEMA9 && curVol > volMA) {
    return {
      direction: 'SELL', slDist, tpDist,
      reason: `S1 SELL: RSI=${rsi.toFixed(1)}>60 MACD↓ price<EMA9 vol=${curVol.toFixed(0)}>${volMA.toFixed(0)}`,
    };
  }
  return N(`S1: no signal (RSI=${rsi.toFixed(1)}, crossUp=${crossUp}, crossDn=${crossDn})`);
}

/**
 * S2 — Volume-Confirmed Breakout with Retest
 *   Consolidation range (20-bar window) must be < 3% of price.
 *   LONG:  close > resistance  AND vol ≥ 1.5× recent-10-bar avg  AND prior-bar retest
 *   SHORT: close < support     AND vol ≥ 1.5× recent-10-bar avg  AND prior-bar retest
 *   SL = max(1.5×ATR, 0.3% price),  TP = 2.5× SL
 */
function s2_breakoutRetest(candles: Candle[], price: number): Vote {
  const N = (r: string): Vote => ({ direction: 'NEUTRAL', slDist: null, tpDist: null, reason: r });
  if (candles.length < 25) return N('S2: need ≥25 candles');

  const len     = candles.length;
  const current = candles[len - 1];
  const prev    = candles[len - 2];

  const rangeWindow = candles.slice(Math.max(0, len - 21), len - 1);
  if (rangeWindow.length < 10) return N('S2: insufficient range window');

  const resistance = Math.max(...rangeWindow.map(c => c.high));
  const support    = Math.min(...rangeWindow.map(c => c.low));
  const rangeSize  = resistance - support;
  const midpoint   = (resistance + support) / 2;

  // NSE stocks can have tighter ranges — use 3% threshold instead of 5%
  if (rangeSize / midpoint > 0.03) {
    return N(`S2: range too wide (${(rangeSize / midpoint * 100).toFixed(2)}%)`);
  }

  const atr      = calculateATR(candles, 14);
  const volRatio = sessionVolumeRatio(candles);
  if (!atr) return N('S2: ATR not ready');

  const retestTolerance = price * 0.003;

  const slDist = Math.max(atr * 1.5, price * 0.003);
  const tpDist = Math.max(slDist * 2.5, price * 0.0075);

  if (current.close > resistance) {
    // sessionVolumeRatio compares current bar to avg of last 10 same-day bars.
    // A valid NSE breakout needs volume surge (≥1.5× recent avg), not just non-zero.
    // Previous threshold of 0.5 only rejected near-dead volume — not a real breakout filter.
    if (volRatio < 1.5) {
      return N(`S2: breakout above ${resistance.toFixed(2)} — no volume surge (${volRatio.toFixed(2)}x < 1.5× avg)`);
    }
    // Only prior-bar retest counts — the breakout candle's low is structurally near
    // resistance and would always pass a wick check, producing false signals.
    const priorRetest = prev
      ? prev.low <= resistance + retestTolerance && prev.close >= resistance - retestTolerance
      : false;
    if (!priorRetest) {
      return N(`S2: breakout above ${resistance.toFixed(2)} vol OK but no prior-bar retest yet`);
    }
    return {
      direction: 'BUY', slDist, tpDist,
      reason: `S2 BUY: close>${resistance.toFixed(2)} vol=${volRatio.toFixed(1)}x retest=prior-bar`,
    };
  }

  if (current.close < support) {
    if (volRatio < 1.5) {
      return N(`S2: breakdown below ${support.toFixed(2)} — no volume surge (${volRatio.toFixed(2)}x < 1.5× avg)`);
    }
    const priorRetest = prev
      ? prev.high >= support - retestTolerance && prev.close <= support + retestTolerance
      : false;
    if (!priorRetest) {
      return N(`S2: breakdown below ${support.toFixed(2)} vol OK but no prior-bar retest yet`);
    }
    return {
      direction: 'SELL', slDist, tpDist,
      reason: `S2 SELL: close<${support.toFixed(2)} vol=${volRatio.toFixed(1)}x retest=prior-bar`,
    };
  }

  return N(`S2: price inside range [${support.toFixed(2)}, ${resistance.toFixed(2)}]`);
}

/**
 * S3 — VWAP Pullback with Momentum Filter
 *   LONG:  price within 0.6% of VWAP  AND lower rejection wick  AND MACD hist > 0  AND RSI 45-65
 *   SHORT: price within 0.6% of VWAP  AND upper rejection wick  AND MACD hist < 0  AND RSI 35-55
 *   SL = max(1.2×ATR, 0.3% price),  TP = max(3.0×ATR, 1% price)
 */
function s3_vwapPullback(candles: Candle[], price: number): Vote {
  const N = (r: string): Vote => ({ direction: 'NEUTRAL', slDist: null, tpDist: null, reason: r });
  if (candles.length < 40) return N('S3: need ≥40 candles');

  const vwap = calculateSessionVWAP(candles);
  if (vwap === null) return N('S3: VWAP unavailable');

  const closes = candles.map(c => c.close);
  const rsi    = calculateRSI(closes, 14);
  const macd   = calculateMACD(closes);
  const atr    = calculateATR(candles, 14);

  if (rsi === null || !macd || !atr) return N('S3: indicator not ready');

  const lastHistogram = macd.histogram[macd.histogram.length - 1];
  const current       = candles[candles.length - 1];

  const distToVwap = Math.abs(price - vwap) / vwap;
  // 0.6% zone: NSE large-caps drift ±0.4-0.8% around VWAP during session;
  // crypto-bot's 0.4% was calibrated for 24/7 BTC precision — too tight for NSE 6.25-hr sessions.
  const nearVwap   = distToVwap <= 0.006;

  if (!nearVwap) {
    return N(`S3: not in VWAP zone (dist=${(distToVwap * 100).toFixed(2)}%)`);
  }

  const body       = Math.abs(current.close - current.open);
  const lowerWick  = Math.min(current.open, current.close) - current.low;
  const upperWick  = current.high - Math.max(current.open, current.close);
  const bodyFloor  = atr * 0.05;

  const hasLowerWick = lowerWick > Math.max(body, bodyFloor) * 1.5;
  const hasUpperWick = upperWick > Math.max(body, bodyFloor) * 1.5;

  const slDist = Math.max(atr * 1.2, price * 0.003);
  // TP = 3×ATR (not 2.5×): when S1+S3 are the two agreeing strategies,
  // avgSl = (1.5+1.2)/2 = 1.35×ATR, avgTp = (2.5+3.0)/2 = 2.75×ATR → 2.04:1 RR ✅
  // With 2.5×ATR the combination averaged 1.85:1 and always failed the 2:1 minimum.
  const tpDist = Math.max(atr * 3.0, price * 0.01);

  // RSI momentum bands calibrated for NSE 5-min VWAP pullbacks:
  //   Long  45-65: captures early recovery phase (RSI 45-52) that crypto-bot's 52 floor misses;
  //                ceiling at 65 avoids chasing overbought bounces.
  //   Short 35-55: upper ceiling 55 (not 48) accepts valid VWAP-resistance rejections where
  //                RSI is 49-55 — common on NSE intraday when stock rallies to VWAP mid-session.
  if (rsi > 45 && rsi < 65 && lastHistogram > 0 && hasLowerWick) {
    return {
      direction: 'BUY', slDist, tpDist,
      reason: `S3 BUY: VWAP=${vwap.toFixed(2)} RSI=${rsi.toFixed(1)} in 45-65 hist>0 lower-wick`,
    };
  }
  if (rsi > 35 && rsi < 55 && lastHistogram < 0 && hasUpperWick) {
    return {
      direction: 'SELL', slDist, tpDist,
      reason: `S3 SELL: VWAP=${vwap.toFixed(2)} RSI=${rsi.toFixed(1)} in 35-55 hist<0 upper-wick`,
    };
  }
  return N(`S3: VWAP zone conditions incomplete (RSI=${rsi.toFixed(1)}, lowerWick=${hasLowerWick}, upperWick=${hasUpperWick})`);
}

// ─── ConfluenceStrategy ───────────────────────────────────────────────────────

/**
 * ConfluenceStrategy
 *
 * Runs three independent sub-strategies (S1, S2, S3) on every 5-min candle
 * refresh and emits a signal when any ≥2 of the 3 agree on direction.
 *
 * Valid combinations:
 *   S1+S2 — momentum reversal + volume breakout
 *   S1+S3 — momentum reversal + VWAP pullback
 *   S2+S3 — volume breakout + VWAP pullback  (both individually hardened, no S1 gate needed)
 *   S1+S2+S3 — full confluence (highest confidence)
 *
 * Additional guards:
 *   • ADX(14) < 15 → skip (choppy/ranging market — NSE 5-min ADX 12-18 is normal trend)
 *   • No new entries after 15:00 IST
 *   • Max 2 trades per symbol per day
 *   • Minimum 1:2 risk-reward enforced on averaged SL/TP
 *
 * Confidence: 0.67 = 2/3 agree, 1.0 = 3/3 agree.
 */
export class ConfluenceStrategy extends BaseStrategy {
  private readonly MAX_TRADES_PER_STOCK_PER_DAY = 2;
  private dayStates: Map<string, DayState> = new Map();
  private watchlist: string[];
  private snapshots: Map<string, ConfluenceSnapshot> = new Map();

  constructor(context: StrategyContext, watchlist: string[]) {
    super('Confluence', context);
    this.watchlist = watchlist;
  }

  public async initialize(): Promise<void> {
    await super.initialize();
    const today = this.todayIST();
    for (const symbol of this.watchlist) {
      this.dayStates.set(symbol, { tradesExecutedToday: 0, lastResetDate: today });
    }
    logger.info('ConfluenceStrategy initialized', { watchlist: this.watchlist.length });
  }

  public handleCandleUpdate(symbol: string, bundle: CandleBundle, ltp: number): void {
    if (!this.isActive) return;

    const position = this.context.positions.get(symbol);
    if (position && position.quantity !== 0) return;

    const state = this.getOrCreateState(symbol);
    this.resetIfNewDay(state);
    if (state.tradesExecutedToday >= this.MAX_TRADES_PER_STOCK_PER_DAY) return;

    if (this.isBeforeSignalStart()) return;
    if (this.isAfterMarketCutoff()) return;

    const candles = bundle.fiveMin;
    if (candles.length < 41) return; // need 40 closed + 1 live

    // Use only closed candles — last element is still-forming
    const closedCandles = candles.slice(0, -1);
    const price = ltp || closedCandles[closedCandles.length - 1].close;

    // ADX regime filter: NSE Nifty 50 5-min trending sessions typically produce ADX 12-18;
    // ADX < 15 reliably identifies flat/choppy conditions without over-filtering valid trends.
    const adx = calculateADX(closedCandles, 14);
    const adxValue = adx !== null ? adx : undefined;
    if (adx !== null && adx < 15) {
      logger.debug(`[Confluence] ${symbol}: ADX=${adx.toFixed(1)}<15 — choppy, skipping`);
      this.snapshots.set(symbol, {
        symbol, adx: adxValue, s1: 'NEUTRAL', s2: 'NEUTRAL', s3: 'NEUTRAL',
        buyVotes: 0, sellVotes: 0, tradesExecutedToday: state.tradesExecutedToday,
      });
      return;
    }

    // Run all 3 sub-strategies on closed candles only
    const votes: Vote[] = [
      s1_rsiMacdScalp(closedCandles, price),
      s2_breakoutRetest(closedCandles, price),
      s3_vwapPullback(closedCandles, price),
    ];

    logger.debug(`[Confluence] ${symbol} votes`, {
      s1: votes[0].direction, s2: votes[1].direction, s3: votes[2].direction,
    });

    const [s1, s2, s3] = votes;
    const buyVotes  = votes.filter(v => v.direction === 'BUY');
    const sellVotes = votes.filter(v => v.direction === 'SELL');

    this.snapshots.set(symbol, {
      symbol, adx: adxValue,
      s1: s1.direction, s2: s2.direction, s3: s3.direction,
      buyVotes: buyVotes.length, sellVotes: sellVotes.length,
      tradesExecutedToday: state.tradesExecutedToday,
    });

    // Any ≥2/3 sub-strategies agreeing is sufficient.
    // S2 and S3 are now individually selective enough (S2: 1.5× volume surge + prior-bar
    // retest; S3: tight 0.6% VWAP zone + RSI bands + wick guard) that their agreement
    // alone constitutes a genuine confluence — making S1 a hard gate was over-engineering.
    const hasLong  = buyVotes.length  >= 2;
    const hasShort = sellVotes.length >= 2;

    if (!hasLong && !hasShort) return;

    const agreeing   = hasLong ? buyVotes : sellVotes;
    const action     = (hasLong ? 'BUY' : 'SELL') as 'BUY' | 'SELL';
    const confidence = agreeing.length / 3;

    // Average SL/TP across agreeing votes
    const slDistances = agreeing.map(v => v.slDist).filter((x): x is number => x !== null);
    const tpDistances = agreeing.map(v => v.tpDist).filter((x): x is number => x !== null);

    const atr    = calculateATR(closedCandles, 14) ?? price * 0.005;
    const avgSl  = slDistances.length ? slDistances.reduce((a, b) => a + b, 0) / slDistances.length : atr;
    const avgTp  = tpDistances.length ? tpDistances.reduce((a, b) => a + b, 0) / tpDistances.length : avgSl * 2;

    // Enforce minimum 1:2 RR
    if (avgTp < avgSl * 2) return;

    const stopLoss = action === 'BUY' ? price - avgSl : price + avgSl;
    const target   = action === 'BUY' ? price + avgTp : price - avgTp;

    const signal: StrategySignal = {
      symbol,
      action,
      stopLoss:         parseFloat(stopLoss.toFixed(2)),
      target:           parseFloat(target.toFixed(2)),
      marginMultiplier: getSymbolMarginMultiplier(symbol),
      useTrailingSL:    false,
      confidence,
      reason: `Confluence(${agreeing.length}/3) | ${agreeing.map(v => v.reason).join(' || ')}`,
    };

    state.tradesExecutedToday++;

    logger.info(`[Confluence] ${action} signal`, {
      symbol,
      price:      price.toFixed(2),
      sl:         stopLoss.toFixed(2),
      target:     target.toFixed(2),
      confidence: `${(confidence * 100).toFixed(0)}%`,
      adx:        adx !== null ? adx.toFixed(1) : 'N/A',
      tradesUsed: `${state.tradesExecutedToday}/${this.MAX_TRADES_PER_STOCK_PER_DAY}`,
    });
    logger.audit('STRATEGY_SIGNAL', { strategy: this.name, signal });

    this.emitSignal(signal);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

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
      state.lastResetDate       = today;
    }
  }

  private todayIST(): string {
    return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).split(',')[0].trim();
  }

  private isAfterMarketCutoff(): boolean {
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return istNow.getHours() >= 15;
  }

  /** Returns true before 09:45 IST — skip opening volatility window. */
  private isBeforeSignalStart(): boolean {
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return istNow.getHours() < 9 || (istNow.getHours() === 9 && istNow.getMinutes() < 45);
  }

  public getSnapshot(): ConfluenceSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  // IStrategy mandatory overrides (candle-driven — no action on tick)
  public onMarketData(_data: MarketData): void {}
  public onPositionUpdate(_position: Position): void {}
}
