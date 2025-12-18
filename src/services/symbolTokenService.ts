import { logger } from '../utils/logger';
import axios from 'axios';

interface SymbolToken {
  symbol: string;
  token: string;
  name: string;
  expiry?: string;
  strike?: string;
  lotsize?: string;
  instrumenttype: string;
  exch_seg: string;
  tick_size?: string;
}

/**
 * Symbol Token Service - Fetches and caches symbol tokens from Angel One API
 * Prevents hardcoded tokens from breaking when Angel One updates their master data
 */
export class SymbolTokenService {
  private symbolTokenCache: Map<string, string> = new Map();
  private lastFetchTime: number = 0;
  private readonly CACHE_VALIDITY_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly MASTER_DATA_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

  /**
   * Get token for a symbol, fetching from API if not cached
   */
  public async getToken(symbol: string): Promise<string | null> {
    // Check cache first
    if (this.symbolTokenCache.has(symbol)) {
      return this.symbolTokenCache.get(symbol) || null;
    }

    // Fetch master data if cache is empty or stale
    if (this.shouldRefreshCache()) {
      await this.fetchMasterData();
    }

    return this.symbolTokenCache.get(symbol) || null;
  }

  /**
   * Get multiple tokens at once
   */
  public async getTokens(symbols: string[]): Promise<Map<string, string>> {
    if (this.shouldRefreshCache()) {
      await this.fetchMasterData();
    }

    const result = new Map<string, string>();
    for (const symbol of symbols) {
      const token = this.symbolTokenCache.get(symbol);
      if (token) {
        result.set(symbol, token);
      }
    }

    return result;
  }

  /**
   * Fetch master data from Angel One API
   */
  private async fetchMasterData(): Promise<void> {
    try {
      logger.info('📥 Fetching symbol master data from Angel One...');

      const response = await axios.get(this.MASTER_DATA_URL, {
        timeout: 30000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        }
      });

      if (!response.data || !Array.isArray(response.data)) {
        logger.error('Invalid master data response from Angel One');
        return;
      }

      this.symbolTokenCache.clear();
      let equityCount = 0;

      // Process master data
      for (const item of response.data) {
        // Only process NSE equity symbols
        if (item.exch_seg === 'NSE' && item.instrumenttype === 'EQ') {
          const symbol = `${item.symbol}-EQ`;
          const token = item.token;

          if (symbol && token) {
            this.symbolTokenCache.set(symbol, token);
            equityCount++;
          }
        }
      }

      this.lastFetchTime = Date.now();

      logger.info('✅ Symbol master data loaded successfully', {
        totalEquities: equityCount,
        cacheSize: this.symbolTokenCache.size
      });

      logger.audit('SYMBOL_MASTER_LOADED', {
        equityCount,
        timestamp: new Date().toISOString()
      });

    } catch (error: any) {
      logger.error('Failed to fetch symbol master data', {
        error: error.message,
        url: this.MASTER_DATA_URL
      });

      // If fetch fails, use fallback hardcoded tokens
      this.loadFallbackTokens();
    }
  }

  /**
   * Load fallback hardcoded tokens if API fetch fails
   */
  private loadFallbackTokens(): void {
    logger.warn('⚠️  Using fallback hardcoded tokens - may be outdated');

    const fallbackTokens: Record<string, string> = {
      'RELIANCE-EQ': '2885',
      'TCS-EQ': '11536',
      'INFY-EQ': '1594',
      'HDFCBANK-EQ': '1333',
      'ICICIBANK-EQ': '4963',
      'TRENT-EQ': '1964',
      'ULTRACEMCO-EQ': '11532',
      'MUTHOOTFIN-EQ': '23650',
      'COFORGE-EQ': '11543',
      'ABB-EQ': '13',
      'ALKEM-EQ': '11703',
      'AMBER-EQ': '1185',
      'ANGELONE-EQ': '324',
      'APOLLOHOSP-EQ': '157',
      'BAJAJ-AUTO-EQ': '16669',
      'BHARTIARTL-EQ': '10604',
      'BRITANNIA-EQ': '547',
      'BSE-EQ': '19585',
      'CUMMINSIND-EQ': '1901',
      'DIXON-EQ': '21690',
      'GRASIM-EQ': '1232',
      'HAL-EQ': '2303',
      'HDFCAMC-EQ': '4244',
      'HEROMOTOCO-EQ': '1348'
    };

    for (const [symbol, token] of Object.entries(fallbackTokens)) {
      this.symbolTokenCache.set(symbol, token);
    }

    logger.info('Fallback tokens loaded', {
      count: Object.keys(fallbackTokens).length
    });
  }

  /**
   * Check if cache should be refreshed
   */
  private shouldRefreshCache(): boolean {
    return this.symbolTokenCache.size === 0 ||
           (Date.now() - this.lastFetchTime) > this.CACHE_VALIDITY_MS;
  }

  /**
   * Manually refresh cache
   */
  public async refreshCache(): Promise<void> {
    logger.info('🔄 Manually refreshing symbol token cache...');
    await this.fetchMasterData();
  }

  /**
   * Get all cached tokens
   */
  public getAllTokens(): Map<string, string> {
    return new Map(this.symbolTokenCache);
  }

  /**
   * Check if a symbol exists in cache
   */
  public hasSymbol(symbol: string): boolean {
    return this.symbolTokenCache.has(symbol);
  }

  /**
   * Get cache statistics
   */
  public getCacheStats() {
    return {
      size: this.symbolTokenCache.size,
      lastFetchTime: new Date(this.lastFetchTime).toISOString(),
      cacheAge: Date.now() - this.lastFetchTime,
      isStale: (Date.now() - this.lastFetchTime) > this.CACHE_VALIDITY_MS
    };
  }
}

// Export singleton instance
export const symbolTokenService = new SymbolTokenService();
