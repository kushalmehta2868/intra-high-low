import { EventEmitter } from "events";
import { logger } from "../utils/logger";

interface VolumeData {
  symbol: string;
  currentVolume: number;
  avgVolume20Day: number;
  volumeRatio: number;
  lastUpdated: Date;
}

interface FiveMinCandle {
  startTime: Date;
  endTime: Date;
  volume: number; // Volume traded within this 5-min window
}

interface CurrentCandleState {
  windowStart: Date; // Start time of the current 5-min window
  startCumVolume: number; // Cumulative session volume at candle open
}

/**
 * Volume Tracker - Tracks and analyzes trading volume for filtering weak breakouts
 *
 * Primary filter: 5-minute candle volume surge
 *   - Builds 5-min candles from cumulative tick volume
 *   - Requires current candle volume > 2x avg of last 10 completed 5-min candles
 *   - Filter activates only after 10 completed candles (~50 min into session)
 *
 * Secondary (legacy): 20-day average volume (kept for compatibility / monitoring)
 */
export class VolumeTracker extends EventEmitter {
  private volumeData: Map<string, VolumeData> = new Map();
  private sessionVolume: Map<string, number> = new Map(); // Cumulative session volume per symbol
  private historicalVolume: Map<string, number[]> = new Map(); // Last 20 days volume (legacy)

  // 5-minute candle tracking
  private completedCandles: Map<string, FiveMinCandle[]> = new Map(); // Last 10 completed candles
  private currentCandle: Map<string, CurrentCandleState> = new Map(); // Current open candle

  // Config
  private readonly FIVE_MIN_MS = 5 * 60 * 1000; // 5 minutes in ms
  private readonly CANDLE_HISTORY = 10; // Number of past candles to average
  private readonly FIVE_MIN_SURGE_THRESHOLD = 2.0; // Current candle must be > 2x avg

  constructor() {
    super();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIMARY: 5-Minute Candle Volume Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Record a market data tick and update 5-min candle state.
   * Call this on every tick instead of updateVolume().
   *
   * @param symbol    - Trading symbol
   * @param cumVolume - Cumulative session volume from the tick (NOT per-tick)
   * @param timestamp - Timestamp of the tick
   */
  public recordTick(symbol: string, cumVolume: number, timestamp: Date): void {
    // Also keep legacy session volume updated for backwards compatibility
    this.sessionVolume.set(symbol, cumVolume);
    this.updateVolumeData(symbol, cumVolume);

    // Determine which 5-min window this tick belongs to
    const windowStart = this.getWindowStart(timestamp);

    const state = this.currentCandle.get(symbol);

    if (!state) {
      // First tick for this symbol — open the first candle
      this.currentCandle.set(symbol, {
        windowStart,
        startCumVolume: cumVolume,
      });
      return;
    }

    // Check if we've crossed into a new 5-min window
    if (windowStart.getTime() !== state.windowStart.getTime()) {
      // Finalise the previous candle
      const candleVolume = cumVolume - state.startCumVolume;

      if (candleVolume >= 0) {
        const completed: FiveMinCandle = {
          startTime: state.windowStart,
          endTime: windowStart,
          volume: candleVolume,
        };

        let candles = this.completedCandles.get(symbol) || [];
        candles.push(completed);

        // Keep only the last N candles
        if (candles.length > this.CANDLE_HISTORY) {
          candles = candles.slice(-this.CANDLE_HISTORY);
        }

        this.completedCandles.set(symbol, candles);

        const avgVol = this.getAvgFiveMinVolume(symbol);
        const ratio = avgVol > 0 ? candleVolume / avgVol : 0;

        logger.info(`📊 [${symbol}] 5-min candle completed`, {
          candleStart: state.windowStart.toLocaleTimeString("en-IN", {
            timeZone: "Asia/Kolkata",
          }),
          candleEnd: windowStart.toLocaleTimeString("en-IN", {
            timeZone: "Asia/Kolkata",
          }),
          candleVolume: candleVolume.toLocaleString(),
          completedCandles: candles.length,
          avgFiveMinVolume: avgVol > 0 ? avgVol.toFixed(0) : "N/A",
          ratio: avgVol > 0 ? `${ratio.toFixed(2)}x` : "N/A",
        });
      }

      // Open the new candle — use current cum volume as the starting baseline
      this.currentCandle.set(symbol, {
        windowStart,
        startCumVolume: cumVolume,
      });
    }
  }

  /**
   * Check if the CURRENT (partial) 5-min candle has a volume surge.
   * Returns true  → current candle volume > 2x average of last 10 candles → signal allowed
   * Returns false → insufficient volume → signal blocked
   * Returns true  → not enough history (< 10 candles) → bypass filter, allow signal
   */
  public hasFiveMinVolumeSurge(symbol: string): boolean {
    const candles = this.completedCandles.get(symbol) || [];

    if (candles.length < this.CANDLE_HISTORY) {
      logger.debug(
        `⏳ [${symbol}] Volume filter bypassed - only ${candles.length}/${this.CANDLE_HISTORY} candles built so far`,
      );
      return true; // Not enough history yet — don't block signals
    }

    const state = this.currentCandle.get(symbol);
    if (!state) {
      logger.debug(
        `⏳ [${symbol}] Volume filter bypassed - no current candle state`,
      );
      return true;
    }

    // Get latest known session volume
    const latestCumVolume = this.sessionVolume.get(symbol) || 0;
    const currentCandleVolume = latestCumVolume - state.startCumVolume;

    const avg = this.getAvgFiveMinVolume(symbol);
    if (avg <= 0) {
      return true; // Can't compute — bypass
    }

    const ratio = currentCandleVolume / avg;
    const hasSurge = ratio >= this.FIVE_MIN_SURGE_THRESHOLD;

    if (!hasSurge) {
      logger.info(
        `🚫 [${symbol}] Volume filter blocked signal - insufficient 5-min volume`,
        {
          currentCandleVolume: currentCandleVolume.toLocaleString(),
          avgFiveMinVolume: avg.toFixed(0),
          volumeRatio: `${ratio.toFixed(2)}x`,
          required: `${this.FIVE_MIN_SURGE_THRESHOLD}x`,
          completedCandles: candles.length,
        },
      );
    } else {
      logger.info(`✅ [${symbol}] Volume surge confirmed`, {
        currentCandleVolume: currentCandleVolume.toLocaleString(),
        avgFiveMinVolume: avg.toFixed(0),
        volumeRatio: `${ratio.toFixed(2)}x`,
        required: `${this.FIVE_MIN_SURGE_THRESHOLD}x`,
      });
    }

    return hasSurge;
  }

  /**
   * Get the average volume of the last N completed 5-min candles
   */
  public getAvgFiveMinVolume(symbol: string): number {
    const candles = this.completedCandles.get(symbol) || [];
    if (candles.length === 0) return 0;
    const sum = candles.reduce((acc, c) => acc + c.volume, 0);
    return sum / candles.length;
  }

  /**
   * Get the current (partial) 5-min candle volume
   */
  public getCurrentCandleVolume(symbol: string): number {
    const state = this.currentCandle.get(symbol);
    if (!state) return 0;
    const cumVol = this.sessionVolume.get(symbol) || 0;
    return Math.max(0, cumVol - state.startCumVolume);
  }

  /**
   * Get number of completed 5-min candles built so far
   */
  public getCompletedCandleCount(symbol: string): number {
    return (this.completedCandles.get(symbol) || []).length;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Round a timestamp down to the nearest 5-min boundary (IST-aware)
   * e.g. 09:37:42 → 09:35:00, 09:42:15 → 09:40:00
   */
  private getWindowStart(timestamp: Date): Date {
    const ms = timestamp.getTime();
    const windowMs = Math.floor(ms / this.FIVE_MIN_MS) * this.FIVE_MIN_MS;
    return new Date(windowMs);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEGACY: 20-Day Daily Average (kept for backwards compatibility)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Update volume data for a symbol (legacy — used when recordTick is not available)
   */
  public updateVolume(symbol: string, volume: number): void {
    this.sessionVolume.set(symbol, volume);
    this.updateVolumeData(symbol, volume);
  }

  private updateVolumeData(symbol: string, volume: number): void {
    const avgVolume = this.getAverageVolume(symbol);
    const volumeRatio = avgVolume > 0 ? volume / avgVolume : 0;

    const volumeData: VolumeData = {
      symbol,
      currentVolume: volume,
      avgVolume20Day: avgVolume,
      volumeRatio,
      lastUpdated: new Date(),
    };

    this.volumeData.set(symbol, volumeData);
  }

  /**
   * Legacy check — now delegates to 5-min surge check
   * @deprecated Use hasFiveMinVolumeSurge() instead
   */
  public hasVolumeSurge(symbol: string): boolean {
    return this.hasFiveMinVolumeSurge(symbol);
  }

  public getVolumeRatio(symbol: string): number {
    const data = this.volumeData.get(symbol);
    return data ? data.volumeRatio : 0;
  }

  public setHistoricalVolume(symbol: string, dailyVolumes: number[]): void {
    const last20Days = dailyVolumes.slice(-20);
    this.historicalVolume.set(symbol, last20Days);

    logger.info("Historical volume data loaded", {
      symbol,
      days: last20Days.length,
      avgVolume: this.getAverageVolume(symbol).toFixed(0),
    });
  }

  private getAverageVolume(symbol: string): number {
    const historical = this.historicalVolume.get(symbol);
    if (!historical || historical.length === 0) return 0;
    const sum = historical.reduce((acc, vol) => acc + vol, 0);
    return sum / historical.length;
  }

  public resetSessionVolume(): void {
    this.sessionVolume.clear();
    this.completedCandles.clear(); // Reset 5-min candles for new day
    this.currentCandle.clear();
    logger.info("Session volume and 5-min candles reset for new trading day");
  }

  public archiveDailyVolume(symbol: string): void {
    const sessionVol = this.sessionVolume.get(symbol);
    if (!sessionVol) return;

    let historical = this.historicalVolume.get(symbol) || [];
    historical.push(sessionVol);

    if (historical.length > 20) {
      historical = historical.slice(-20);
    }

    this.historicalVolume.set(symbol, historical);

    logger.info("Daily volume archived", {
      symbol,
      volume: sessionVol,
      newAvg: this.getAverageVolume(symbol).toFixed(0),
    });
  }

  public getVolumeStats(symbol: string): VolumeData | null {
    return this.volumeData.get(symbol) || null;
  }

  public getAllVolumeData(): VolumeData[] {
    return Array.from(this.volumeData.values());
  }
}

// Singleton instance
export const volumeTracker = new VolumeTracker();
