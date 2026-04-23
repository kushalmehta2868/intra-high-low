import { logger } from '../utils/logger';
import axios from 'axios';

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
        this.loadFallbackTokens();
        return;
      }

      this.symbolTokenCache.clear();
      let equityCount = 0;

      // Process master data.
      // In Angel One's ScripMaster the symbol field already carries the exchange suffix
      // (e.g. "HINDALCO-EQ") and instrumenttype is "" for equities — NOT "EQ".
      // We identify equity rows by checking that the symbol ends with "-EQ".
      for (const item of response.data) {
        if (
          item.exch_seg === 'NSE' &&
          item.symbol &&
          typeof item.symbol === 'string' &&
          item.symbol.endsWith('-EQ') &&
          item.token
        ) {
          this.symbolTokenCache.set(item.symbol, item.token);
          equityCount++;
        }
      }

      // If no equities were found, API response structure might have changed
      // Use fallback tokens instead
      if (equityCount === 0) {
        logger.warn('⚠️  No equity symbols found in master data - API structure may have changed');
        // Log first few items so we can see the actual format and fix the filter
        const sample = response.data.slice(0, 3);
        logger.info('ScripMaster sample rows (first 3 items):', { sample });
        this.loadFallbackTokens();
        return;
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
      // Banking & Finance
      'HDFCBANK-EQ': '1333',
      'ICICIBANK-EQ': '4963',
      'KOTAKBANK-EQ': '1922',
      'SBIN-EQ': '3045',
      'AXISBANK-EQ': '5900',
      'INDUSINDBK-EQ': '5258',
      'BAJFINANCE-EQ': '317',
      'BAJAJFINSV-EQ': '16675',
      'SHRIRAMFIN-EQ': '4306',
      // IT
      'TCS-EQ': '11536',
      'INFY-EQ': '1594',
      'HCLTECH-EQ': '7229',
      'WIPRO-EQ': '3787',
      'TECHM-EQ': '13538',
      // Oil & Gas / Energy
      'RELIANCE-EQ': '2885',
      'ONGC-EQ': '2475',
      'BPCL-EQ': '526',
      'NTPC-EQ': '11630',
      'POWERGRID-EQ': '14977',
      // Auto
      'MARUTI-EQ': '10999',
      'BAJAJ-AUTO-EQ': '16669',
      'EICHERMOT-EQ': '910',
      'HEROMOTOCO-EQ': '1348',
      'M&M-EQ': '2031',
      // Metals & Mining
      'TATASTEEL-EQ': '3499',
      'JSWSTEEL-EQ': '11723',
      'HINDALCO-EQ': '1363',
      'COALINDIA-EQ': '20374',
      // Pharma
      'SUNPHARMA-EQ': '3351',
      'DRREDDY-EQ': '881',
      'CIPLA-EQ': '694',
      // Consumer / FMCG
      'HINDUNILVR-EQ': '1394',
      'ITC-EQ': '1660',
      'BRITANNIA-EQ': '547',
      'NESTLEIND-EQ': '17963',
      'TATACONSUM-EQ': '3432',
      // Cement & Building
      'ULTRACEMCO-EQ': '11532',
      'GRASIM-EQ': '1232',
      // Telecom
      'BHARTIARTL-EQ': '10604',
      // Infra & Engineering
      'LT-EQ': '11483',
      'ADANIPORTS-EQ': '15083',
      'ADANIENT-EQ': '25',
      'BEL-EQ': '383',
      // Healthcare
      'APOLLOHOSP-EQ': '157',
      // Consumer Discretionary
      'ASIANPAINT-EQ': '236',
      'TITAN-EQ': '3506',
      'TRENT-EQ': '1964',
      // New Economy
      'ETERNAL-EQ': '21808',
    };

    for (const [symbol, token] of Object.entries(fallbackTokens)) {
      this.symbolTokenCache.set(symbol, token);
    }

    // Set lastFetchTime to prevent continuous retry attempts
    this.lastFetchTime = Date.now();

    logger.info('✅ Fallback tokens loaded', {
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
