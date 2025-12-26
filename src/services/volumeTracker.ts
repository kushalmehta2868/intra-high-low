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
   */
  public updateVolume(symbol: string, volume: number): void {
    // Update session volume (cumulative)
    const currentSessionVolume = this.sessionVolume.get(symbol) || 0;
    this.sessionVolume.set(symbol, currentSessionVolume + volume);

    // Calculate volume ratio
    const avgVolume = this.getAverageVolume(symbol);
    const volumeRatio = avgVolume > 0 ? (currentSessionVolume + volume) / avgVolume : 0;

    const volumeData: VolumeData = {
      symbol,
      currentVolume: currentSessionVolume + volume,
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

    if (!data) {
      logger.warn('No volume data available for symbol', { symbol });
      return false; // Conservative: reject if no data
    }

    const hasEnoughVolume = data.volumeRatio >= this.VOLUME_SURGE_THRESHOLD;

    if (!hasEnoughVolume) {
      logger.info('Volume filter rejected signal', {
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
      // Fallback: use a default average (or could fetch from API)
      // For now, return a high number so volume filter doesn't block unnecessarily
      // In production, you MUST fetch real historical data
      logger.warn('No historical volume data - using default', { symbol });
      return 1000000; // 10 lakh shares as default
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
