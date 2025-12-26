import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface VolumeData {
  symbol: string;
  currentVolume: number;
  avgVolume20Day: number;
  volumeRatio: number;
  lastUpdated: Date;
}

/**
 * Volume Tracker - Tracks and analyzes trading volume for filtering weak breakouts
 * Maintains 20-day average volume and current session volume
 */
export class VolumeTracker extends EventEmitter {
  private volumeData: Map<string, VolumeData> = new Map();
  private sessionVolume: Map<string, number> = new Map(); // Cumulative volume for current session
  private historicalVolume: Map<string, number[]> = new Map(); // Last 20 days volume

  // Volume filter threshold
  private readonly VOLUME_SURGE_THRESHOLD = 1.5; // 1.5x average required

  constructor() {
    super();
  }

  /**
   * Update volume data for a symbol
   * @param symbol - Symbol to update
   * @param volume - Cumulative volume for the day (from market data feed)
   */
  public updateVolume(symbol: string, volume: number): void {
    // Volume from market data is already cumulative for the session
    // Just store it directly, don't add to previous value
    this.sessionVolume.set(symbol, volume);

    // Calculate volume ratio
    const avgVolume = this.getAverageVolume(symbol);
    const volumeRatio = avgVolume > 0 ? volume / avgVolume : 0;

    const volumeData: VolumeData = {
      symbol,
      currentVolume: volume,
      avgVolume20Day: avgVolume,
      volumeRatio,
      lastUpdated: new Date()
    };

    this.volumeData.set(symbol, volumeData);
  }

  /**
   * Check if volume meets the surge threshold for valid breakout
   */
  public hasVolumeSurge(symbol: string): boolean {
    const data = this.volumeData.get(symbol);

    // If no volume data available at all, bypass volume filter
    // (Historical data not loaded - feature is disabled)
    if (!data) {
      logger.debug('No volume data available - bypassing volume filter', { symbol });
      return true; // Allow signal when feature is not configured
    }

    // If historical volume is not set (using default fallback), bypass the filter
    const historical = this.historicalVolume.get(symbol);
    if (!historical || historical.length === 0) {
      logger.debug('No historical volume data - bypassing volume filter', { symbol });
      return true; // Allow signal when historical data is not available
    }

    const hasEnoughVolume = data.volumeRatio >= this.VOLUME_SURGE_THRESHOLD;

    if (!hasEnoughVolume) {
      logger.info('🚫 Volume filter rejected signal', {
        symbol,
        currentVolume: data.currentVolume,
        avgVolume: data.avgVolume20Day.toFixed(0),
        volumeRatio: `${data.volumeRatio.toFixed(2)}x`,
        threshold: `${this.VOLUME_SURGE_THRESHOLD}x`,
        reason: 'Insufficient volume for valid breakout'
      });
    }

    return hasEnoughVolume;
  }

  /**
   * Get current volume ratio for a symbol
   */
  public getVolumeRatio(symbol: string): number {
    const data = this.volumeData.get(symbol);
    return data ? data.volumeRatio : 0;
  }

  /**
   * Set historical 20-day average volume for a symbol
   * This should be fetched from broker API on initialization
   */
  public setHistoricalVolume(symbol: string, dailyVolumes: number[]): void {
    // Keep only last 20 days
    const last20Days = dailyVolumes.slice(-20);
    this.historicalVolume.set(symbol, last20Days);

    logger.info('Historical volume data loaded', {
      symbol,
      days: last20Days.length,
      avgVolume: this.getAverageVolume(symbol).toFixed(0)
    });
  }

  /**
   * Calculate 20-day average volume
   */
  private getAverageVolume(symbol: string): number {
    const historical = this.historicalVolume.get(symbol);

    if (!historical || historical.length === 0) {
      // Return 0 when no historical data - caller should check and bypass filter
      return 0;
    }

    const sum = historical.reduce((acc, vol) => acc + vol, 0);
    return sum / historical.length;
  }

  /**
   * Reset session volume at start of new trading day
   */
  public resetSessionVolume(): void {
    this.sessionVolume.clear();
    logger.info('Session volume reset for new trading day');
  }

  /**
   * Add today's volume to historical data (call at end of day)
   */
  public archiveDailyVolume(symbol: string): void {
    const sessionVol = this.sessionVolume.get(symbol);
    if (!sessionVol) return;

    let historical = this.historicalVolume.get(symbol) || [];
    historical.push(sessionVol);

    // Keep only last 20 days
    if (historical.length > 20) {
      historical = historical.slice(-20);
    }

    this.historicalVolume.set(symbol, historical);

    logger.info('Daily volume archived', {
      symbol,
      volume: sessionVol,
      newAvg: this.getAverageVolume(symbol).toFixed(0)
    });
  }

  /**
   * Get volume statistics for a symbol
   */
  public getVolumeStats(symbol: string): VolumeData | null {
    return this.volumeData.get(symbol) || null;
  }

  /**
   * Get all volume data (for debugging/monitoring)
   */
  public getAllVolumeData(): VolumeData[] {
    return Array.from(this.volumeData.values());
  }
}

// Singleton instance
export const volumeTracker = new VolumeTracker();
