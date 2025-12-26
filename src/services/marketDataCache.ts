import { EventEmitter } from 'events';
import { MarketData } from '../types';
import { logger } from '../utils/logger';

/**
 * Market Data Cache - Stores real-time WebSocket market data
 * Eliminates need for repeated getLTP/getMarketData API calls
 *
 * Benefits:
 * - Zero API calls for price data
 * - Instant access to latest prices
 * - Includes OHLC + Volume data
 * - Automatic stale data detection
 * - Automatic memory cleanup
 */
export class MarketDataCache extends EventEmitter {
  private cache: Map<string, MarketData> = new Map();
  private readonly STALE_DATA_THRESHOLD_MS = 60000; // 1 minute - data older than this is stale
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Clean every 5 minutes
  private readonly MAX_CACHE_SIZE = 1000; // Prevent memory overflow

  constructor() {
    super();
    this.startAutomaticCleanup();
  }

  /**
   * Start automatic cleanup of stale data to prevent memory leaks
   */
  private startAutomaticCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const removed = this.clearStaleData();
      if (removed > 0) {
        logger.debug('Automatic cache cleanup', {
          removed,
          remaining: this.cache.size
        });
      }

      // Check cache size and warn if approaching limit
      if (this.cache.size > this.MAX_CACHE_SIZE * 0.8) {
        logger.warn('⚠️ Cache size approaching limit', {
          size: this.cache.size,
          limit: this.MAX_CACHE_SIZE,
          percentUsed: ((this.cache.size / this.MAX_CACHE_SIZE) * 100).toFixed(1)
        });
      }
    }, this.CLEANUP_INTERVAL_MS);

    // Prevent cleanup interval from keeping process alive
    this.cleanupInterval.unref();
  }

  /**
   * Stop automatic cleanup (call on shutdown)
   */
  public stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.debug('Cache cleanup stopped');
    }
  }

  /**
   * Update cache with fresh market data from WebSocket
   */
  public update(data: MarketData): void {
    // CRITICAL: Prevent unbounded cache growth
    if (this.cache.size >= this.MAX_CACHE_SIZE && !this.cache.has(data.symbol)) {
      logger.warn('⚠️ Cache full - removing oldest entry', {
        size: this.cache.size,
        limit: this.MAX_CACHE_SIZE
      });

      // Remove oldest entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    const previousData = this.cache.get(data.symbol);
    this.cache.set(data.symbol, data);

    // Emit price change event if price moved
    if (previousData && previousData.ltp !== data.ltp) {
      this.emit('price_change', {
        symbol: data.symbol,
        oldPrice: previousData.ltp,
        newPrice: data.ltp,
        change: data.ltp - previousData.ltp,
        changePercent: ((data.ltp - previousData.ltp) / previousData.ltp) * 100
      });
    }

    logger.debug('Market data cached', {
      symbol: data.symbol,
      ltp: `₹${data.ltp.toFixed(2)}`,
      cacheSize: this.cache.size
    });
  }

  /**
   * Get latest LTP for a symbol (replaces broker.getLTP())
   * Returns null if data not available or stale
   */
  public getLTP(symbol: string): number | null {
    const data = this.cache.get(symbol);

    if (!data) {
      logger.debug('Cache miss - no data for symbol', { symbol });
      return null;
    }

    // Check if data is stale
    const age = Date.now() - data.timestamp.getTime();
    if (age > this.STALE_DATA_THRESHOLD_MS) {
      logger.warn('Cached data is stale', {
        symbol,
        ageSeconds: Math.floor(age / 1000),
        thresholdSeconds: this.STALE_DATA_THRESHOLD_MS / 1000
      });
      return null;
    }

    return data.ltp;
  }

  /**
   * Get full market data for a symbol (OHLC + Volume)
   * Returns null if data not available or stale
   */
  public getMarketData(symbol: string): MarketData | null {
    const data = this.cache.get(symbol);

    if (!data) {
      logger.debug('Cache miss - no data for symbol', { symbol });
      return null;
    }

    // Check if data is stale
    const age = Date.now() - data.timestamp.getTime();
    if (age > this.STALE_DATA_THRESHOLD_MS) {
      logger.warn('Cached data is stale', {
        symbol,
        ageSeconds: Math.floor(age / 1000),
        thresholdSeconds: this.STALE_DATA_THRESHOLD_MS / 1000
      });
      return null;
    }

    return data;
  }

  /**
   * Get LTPs for multiple symbols at once
   * Useful for batch operations
   */
  public getBatchLTP(symbols: string[]): Map<string, number> {
    const result = new Map<string, number>();

    for (const symbol of symbols) {
      const ltp = this.getLTP(symbol);
      if (ltp !== null) {
        result.set(symbol, ltp);
      }
    }

    return result;
  }

  /**
   * Get all cached market data
   * Returns only fresh data (not stale)
   */
  public getAllMarketData(): Map<string, MarketData> {
    const result = new Map<string, MarketData>();
    const now = Date.now();

    for (const [symbol, data] of this.cache.entries()) {
      const age = now - data.timestamp.getTime();

      if (age <= this.STALE_DATA_THRESHOLD_MS) {
        result.set(symbol, data);
      }
    }

    return result;
  }

  /**
   * Check if we have fresh data for a symbol
   */
  public hasData(symbol: string): boolean {
    const data = this.cache.get(symbol);
    if (!data) return false;

    const age = Date.now() - data.timestamp.getTime();
    return age <= this.STALE_DATA_THRESHOLD_MS;
  }

  /**
   * Get cache statistics
   */
  public getStats() {
    const now = Date.now();
    let freshCount = 0;
    let staleCount = 0;
    const ages: number[] = [];

    for (const data of this.cache.values()) {
      const age = now - data.timestamp.getTime();
      ages.push(age);

      if (age <= this.STALE_DATA_THRESHOLD_MS) {
        freshCount++;
      } else {
        staleCount++;
      }
    }

    const avgAge = ages.length > 0
      ? ages.reduce((a, b) => a + b, 0) / ages.length
      : 0;

    return {
      totalSymbols: this.cache.size,
      freshData: freshCount,
      staleData: staleCount,
      avgAgeMs: avgAge,
      avgAgeSeconds: avgAge / 1000
    };
  }

  /**
   * Clear stale data from cache
   * Useful for memory management
   */
  public clearStaleData(): number {
    const now = Date.now();
    let removedCount = 0;

    for (const [symbol, data] of this.cache.entries()) {
      const age = now - data.timestamp.getTime();

      if (age > this.STALE_DATA_THRESHOLD_MS) {
        this.cache.delete(symbol);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.info('Cleared stale data from cache', {
        removed: removedCount,
        remaining: this.cache.size
      });
    }

    return removedCount;
  }

  /**
   * Clear all cached data
   */
  public clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    logger.info('Market data cache cleared', { previousSize: size });
  }

  /**
   * Get list of all cached symbols
   */
  public getSymbols(): string[] {
    return Array.from(this.cache.keys());
  }
}

// Singleton instance for global access
export const marketDataCache = new MarketDataCache();
