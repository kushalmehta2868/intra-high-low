import { Candle } from '../types';

/**
 * Calculate EMA for an array of closes (oldest-first).
 * Seeds with SMA of the first `period` values.
 * Returns an array of length (closes.length - period + 1).
 */
export function calculateEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];

  const k = 2 / (period + 1);
  const result: number[] = [];

  const seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(seed);

  for (let i = period; i < closes.length; i++) {
    result.push(closes[i] * k + result[result.length - 1] * (1 - k));
  }

  return result;
}

/**
 * Calculate ATR(period) for candles (oldest-first) using Wilder's smoothing.
 * Seeds with the simple mean of the first `period` true ranges, then applies
 * Wilder's EMA: ATR = (prevATR * (period-1) + currentTR) / period.
 * Returns null if there is insufficient data.
 */
export function calculateATR(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1) return null;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  // Seed: simple mean of first `period` true ranges
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Wilder's smoothing for remaining true ranges
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  return atr;
}

/**
 * Calculate RSI(period) for an array of closes (oldest-first) using Wilder's smoothing.
 * Seeds with the simple mean of gains/losses over the first `period` changes,
 * then applies Wilder's EMA for subsequent values.
 * Returns null if there is insufficient data.
 */
export function calculateRSI(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;

  // Seed: simple mean of first `period` up/down moves
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing for remaining closes
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

/**
 * Determine trend direction from EMA(period) slope on 1H candles (oldest-first).
 * Uses a small threshold (0.01%) to filter noise.
 */
export function get1HTrend(
  oneHourCandles: Candle[],
  period: number = 21,
): 'UP' | 'DOWN' | 'NEUTRAL' {
  if (oneHourCandles.length < period + 1) return 'NEUTRAL';

  const closes = oneHourCandles.map(c => c.close);
  const emas = calculateEMA(closes, period);
  if (emas.length < 2) return 'NEUTRAL';

  const last = emas[emas.length - 1];
  const prev = emas[emas.length - 2];

  if (last > prev * 1.001) return 'UP';
  if (last < prev * 0.999) return 'DOWN';
  return 'NEUTRAL';
}

/**
 * Determine trend direction from EMA(period) slope on 30-min candles (oldest-first).
 * Uses a small threshold (0.01%) to filter noise.
 */
export function get30MinTrend(
  thirtyMinCandles: Candle[],
  period: number = 21,
): 'UP' | 'DOWN' | 'NEUTRAL' {
  if (thirtyMinCandles.length < period + 1) return 'NEUTRAL';

  const closes = thirtyMinCandles.map(c => c.close);
  const emas = calculateEMA(closes, period);
  if (emas.length < 2) return 'NEUTRAL';

  const last = emas[emas.length - 1];
  const prev = emas[emas.length - 2];

  if (last > prev * 1.001) return 'UP';
  if (last < prev * 0.999) return 'DOWN';
  return 'NEUTRAL';
}

/**
 * Calculate average volume over the last `period` candles (oldest-first).
 * Excludes the current (last) candle from the average so we compare
 * the live candle against the historical baseline.
 */
export function avgVolume(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 0;
  const history = candles.slice(-(period + 1), -1);
  return history.reduce((s, c) => s + c.volume, 0) / period;
}

/**
 * Session Volume Ratio — compares the last candle's volume to the average of
 * the most recent `lookback` candles from the same trading day.
 *
 * Uses a rolling window rather than the all-day average because intraday volume
 * follows a U-curve (high open, low mid-day, high close). Comparing a 12pm candle
 * to an all-day average that includes the high-volume 9:15am opening candles would
 * make genuine mid-day surges look weak. A rolling window of recent same-day
 * candles reflects actual current activity level.
 *
 * A ratio ≥ 1.5 means the candle traded 50% more than recent typical activity.
 *
 * @param candles   Closed candles only (live/partial candle must already be excluded).
 * @param lookback  Number of recent same-day candles to use as baseline (default 10).
 * @returns ratio, or 0 if fewer than 2 same-day candles exist.
 */
export function sessionVolumeRatio(candles: Candle[], lookback = 10): number {
  if (candles.length < 2) return 0;

  const current     = candles[candles.length - 1];
  const currentDate = current.timestamp.toDateString();

  const todayPrior = candles
    .slice(0, -1)
    .filter(c => c.timestamp.toDateString() === currentDate);

  if (todayPrior.length === 0) return 0;

  // Use the most recent `lookback` candles as the baseline (or all available if fewer)
  const window = todayPrior.slice(-lookback);
  const avg    = window.reduce((sum, c) => sum + c.volume, 0) / window.length;
  return avg > 0 ? current.volume / avg : 0;
}

export interface MACDResult {
  macdLine:   number[];
  signalLine: number[];
  histogram:  number[];
}

/**
 * MACD(fast=12, slow=26, signal=9) over oldest-first closes.
 * Returns null when fewer than slow + signal bars are available.
 */
export function calculateMACD(
  closes: number[],
  fastPeriod   = 12,
  slowPeriod   = 26,
  signalPeriod = 9,
): MACDResult | null {
  if (closes.length < slowPeriod + signalPeriod) return null;

  const fastEMA = calculateEMA(closes, fastPeriod);
  const slowEMA = calculateEMA(closes, slowPeriod);

  const offset      = slowPeriod - fastPeriod;
  const alignedFast = fastEMA.slice(offset);
  if (alignedFast.length !== slowEMA.length) return null;

  const macdFull = alignedFast.map((f, i) => f - slowEMA[i]);
  const sigLine  = calculateEMA(macdFull, signalPeriod);
  if (sigLine.length < 2) return null;

  const trimmed   = macdFull.slice(macdFull.length - sigLine.length);
  const histogram = trimmed.map((m, i) => m - sigLine[i]);

  return { macdLine: trimmed, signalLine: sigLine, histogram };
}

/**
 * ADX(period) — measures trend strength regardless of direction.
 * ADX > 20 = trending; ADX < 20 = choppy/ranging.
 * Uses Wilder's smoothing. Returns null when fewer than 2×period + 1 bars available.
 */
export function calculateADX(candles: Candle[], period: number): number | null {
  if (candles.length < period * 2 + 1) return null;
  const slice = candles.slice(-(period * 2 + 1));

  const plusDMs:  number[] = [];
  const minusDMs: number[] = [];
  const trs:      number[] = [];

  for (let i = 1; i < slice.length; i++) {
    const c = slice[i], p = slice[i - 1];
    const up   = c.high - p.high;
    const down = p.low  - c.low;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }

  let smPlus  = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smMinus = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smTR    = trs.slice(0, period).reduce((a, b) => a + b, 0);

  const dxValues: number[] = [];
  const pushDX = (sp: number, sm: number, st: number) => {
    if (st === 0) return;
    const pdi = 100 * sp / st, mdi = 100 * sm / st, sum = pdi + mdi;
    if (sum > 0) dxValues.push(100 * Math.abs(pdi - mdi) / sum);
  };
  pushDX(smPlus, smMinus, smTR);

  for (let i = period; i < trs.length; i++) {
    smPlus  = smPlus  - smPlus  / period + plusDMs[i];
    smMinus = smMinus - smMinus / period + minusDMs[i];
    smTR    = smTR    - smTR    / period + trs[i];
    pushDX(smPlus, smMinus, smTR);
  }

  if (dxValues.length < period) return null;

  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }
  return adx;
}

/**
 * Session VWAP — resets at 09:15 IST (NSE market open) each day.
 * Returns null when no session candles are present.
 */
export function calculateSessionVWAP(candles: Candle[]): number | null {
  // Compute today's 09:15 IST as a UTC Date:
  // IST = UTC+5:30, so 09:15 IST = 03:45 UTC on the same IST calendar date.
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const nowIST      = new Date(Date.now() + istOffsetMs);
  const sessionStart = new Date(Date.UTC(
    nowIST.getUTCFullYear(),
    nowIST.getUTCMonth(),
    nowIST.getUTCDate(),
    3, 45, 0,  // 03:45 UTC = 09:15 IST
  ));

  const session = candles.filter(c => c.timestamp >= sessionStart);
  if (session.length === 0) return null;

  let sumTPV = 0, sumV = 0;
  for (const c of session) {
    const tp  = (c.high + c.low + c.close) / 3;
    sumTPV   += tp * c.volume;
    sumV     += c.volume;
  }
  return sumV === 0 ? null : sumTPV / sumV;
}
