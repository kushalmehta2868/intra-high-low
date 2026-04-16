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
 * Calculate ATR(period) for candles (oldest-first).
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

  const lastN = trs.slice(-period);
  return lastN.reduce((a, b) => a + b, 0) / lastN.length;
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

  if (last > prev * 1.0001) return 'UP';
  if (last < prev * 0.9999) return 'DOWN';
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

  if (last > prev * 1.0001) return 'UP';
  if (last < prev * 0.9999) return 'DOWN';
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
