import { EventEmitter } from 'events';
import { AngelOneClient } from '../brokers/angelone/client';
import { MarketData } from '../types';
import { logger } from '../utils/logger';
import { symbolTokenService } from './symbolTokenService';

interface SymbolPriceTracking {
  open: number;
  high: number;
  low: number;
  lastClose: number;
}

export class MarketDataFetcher extends EventEmitter {
  private client: AngelOneClient;
  private symbols: string[] = []; // Watchlist symbols
  private priceTracking: Map<string, SymbolPriceTracking> = new Map(); // Track OHLC
  private isRunning: boolean = false;
  private fetchInterval: NodeJS.Timeout | null = null;
  private readonly FETCH_INTERVAL_MS = 5000; // Fetch every 5 seconds
  private readonly IST_TIMEZONE = 'Asia/Kolkata';
  private marketStartTime: string = '09:15';
  private marketEndTime: string = '15:30';

  constructor(client: AngelOneClient, watchlist: string[] = [], marketStartTime?: string, marketEndTime?: string) {
    super();
    this.client = client;
    this.symbols = watchlist.length > 0 ? watchlist : this.getDefaultWatchlist();
    if (marketStartTime) this.marketStartTime = marketStartTime;
    if (marketEndTime) this.marketEndTime = marketEndTime;
    this.initializePriceTracking();
  }

  private getDefaultWatchlist(): string[] {
    return [
      'RELIANCE-EQ',
      'TCS-EQ',
      'INFY-EQ',
      'HDFCBANK-EQ',
      'ICICIBANK-EQ',
      'TRENT-EQ',
      'ULTRACEMCO-EQ',
      'MUTHOOTFIN-EQ',
      'COFORGE-EQ',
      'ABB-EQ',
      'ALKEM-EQ',
      'AMBER-EQ',
      'ANGELONE-EQ',
      'APOLLOHOSP-EQ',
      'BAJAJ-AUTO-EQ',
      'BHARTIARTL-EQ',
      'BRITANNIA-EQ',
      'BSE-EQ',
      'CUMMINSIND-EQ',
      'DIXON-EQ',
      'GRASIM-EQ',
      'HAL-EQ',
      'HDFCAMC-EQ',
      'HEROMOTOCO-EQ'
    ];
  }

  private initializePriceTracking(): void {
    // Initialize price tracking for each symbol
    for (const symbol of this.symbols) {
      this.priceTracking.set(symbol, {
        open: 0,
        high: 0,
        low: Infinity,
        lastClose: 0
      });
    }

    logger.info('Market data symbols initialized', {
      symbols: this.symbols,
      count: this.symbols.length
    });
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Market data fetcher already running');
      return;
    }

    logger.info('🔄 Starting market data fetcher...');
    this.isRunning = true;

    // Fetch immediately
    await this.fetchAllMarketData();

    // Then fetch every 5 seconds
    this.fetchInterval = setInterval(async () => {
      await this.fetchAllMarketData();
    }, this.FETCH_INTERVAL_MS);

    logger.info(`✅ Market data fetcher started (fetching every ${this.FETCH_INTERVAL_MS / 1000}s)`);
  }

  public stop(): void {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping market data fetcher...');
    this.isRunning = false;

    if (this.fetchInterval) {
      clearInterval(this.fetchInterval);
      this.fetchInterval = null;
    }

    // Remove all event listeners to prevent memory leaks
    this.removeAllListeners();

    logger.info('✅ Market data fetcher stopped and cleaned up');
  }

  /**
   * Check if current time is within market hours (IST timezone)
   */
  private isMarketHours(): boolean {
    // Get current time in IST
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: this.IST_TIMEZONE }));
    const day = istTime.getDay();

    // Weekend check (Saturday = 6, Sunday = 0)
    if (day === 0 || day === 6) {
      return false;
    }

    const currentTime = `${String(istTime.getHours()).padStart(2, '0')}:${String(istTime.getMinutes()).padStart(2, '0')}`;

    return currentTime >= this.marketStartTime && currentTime <= this.marketEndTime;
  }

  private async fetchAllMarketData(): Promise<void> {
    // CRITICAL FIX: Don't fetch data outside market hours
    if (!this.isMarketHours()) {
      logger.debug('⏸️  Outside market hours - skipping data fetch', {
        currentTime: new Date().toLocaleTimeString('en-IN', { timeZone: this.IST_TIMEZONE }),
        marketHours: `${this.marketStartTime} - ${this.marketEndTime}`
      });
      return;
    }

    try {
      // Get tokens for all symbols dynamically
      const tokensMap = await symbolTokenService.getTokens(this.symbols);
      const tokens = Array.from(tokensMap.values());

      if (tokens.length === 0) {
        logger.debug('Symbol tokens not yet loaded, skipping this fetch cycle');
        return;
      }

      // CRITICAL FIX: Split large watchlists into smaller batches to avoid API limits
      // Angel One API may fail with too many symbols at once
      const BATCH_SIZE = 10; // Process 10 symbols at a time
      const symbolBatches: string[][] = [];

      for (let i = 0; i < this.symbols.length; i += BATCH_SIZE) {
        symbolBatches.push(this.symbols.slice(i, i + BATCH_SIZE));
      }

      logger.debug(`Fetching market data in ${symbolBatches.length} batches (${BATCH_SIZE} symbols each)`);

      // Process each batch sequentially with error recovery
      for (let batchIndex = 0; batchIndex < symbolBatches.length; batchIndex++) {
        const batch = symbolBatches[batchIndex];

        try {
          const batchTokens: string[] = [];
          const batchTokensMap = new Map<string, string>();

          for (const symbol of batch) {
            const token = tokensMap.get(symbol);
            if (token) {
              batchTokens.push(token);
              batchTokensMap.set(symbol, token);
            }
          }

          if (batchTokens.length === 0) continue;

          // Prepare exchangeTokens for batch request
          const exchangeTokens: { [key: string]: string[] } = {
            'NSE': batchTokens
          };

          // Fetch market data for this batch with timeout (30s for network latency on Render)
          const TIMEOUT_MS = 30000; // 30 seconds - increased for cloud deployment
          const marketData = await Promise.race([
            this.client.getMarketData('OHLC', exchangeTokens),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Market data fetch timeout after ${TIMEOUT_MS}ms for batch ${batchIndex + 1}`)), TIMEOUT_MS)
            )
          ]) as any;

          if (!marketData || !marketData.fetched) {
            logger.warn(`No market data received for batch ${batchIndex + 1}/${symbolBatches.length}`);
            continue;
          }

          // Process each symbol's data in this batch
          for (const symbol of batch) {
            const token = batchTokensMap.get(symbol);
            if (!token) {
              continue;
            }

            const symbolData = marketData.fetched.find((item: any) => item.symbolToken === token);
            if (symbolData) {
              this.processSymbolData(symbol, symbolData);
            } else {
              logger.debug(`No data received for ${symbol} in batch`);
            }
          }

          // Small delay between batches to avoid rate limiting
          if (batchIndex < symbolBatches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }

        } catch (batchError: any) {
          const isTimeout = batchError.message?.includes('timeout');
          const logLevel = isTimeout ? 'warn' : 'error';

          logger[logLevel](`Failed to fetch batch ${batchIndex + 1}/${symbolBatches.length}`, {
            error: batchError.message,
            symbols: batch,
            isTimeout,
            suggestion: isTimeout ? 'Network latency detected - will retry on next cycle' : 'Check API connectivity'
          });

          // Continue with next batch even if this one fails - non-fatal error
          continue;
        }
      }

    } catch (error: any) {
      logger.error('Error in market data fetcher', {
        error: error.message,
        stack: error.stack
      });
      // Don't throw - let the interval retry on next cycle
    }
  }

  private processSymbolData(symbol: string, data: any): void {
    try {
      // Get tracking data for this symbol
      const tracking = this.priceTracking.get(symbol);
      if (!tracking) {
        logger.error(`No tracking data for ${symbol}`);
        return;
      }

      // Extract OHLC data from API response
      const open = parseFloat(data.open);
      const high = parseFloat(data.high);
      const low = parseFloat(data.low);
      const ltp = parseFloat(data.ltp);

      // FIXED: Check for invalid prices (NaN or negative), not falsy values
      // parseFloat("0.50") returns 0.5 which is truthy, but 0 is falsy
      // This was incorrectly dropping valid low-price stocks
      if (isNaN(ltp) || ltp < 0) {
        logger.warn(`Invalid price data for ${symbol}`, { ltp: data.ltp });
        return;
      }

      // Initialize open price if not set (first tick of the day)
      if (tracking.open === 0) {
        tracking.open = open;
        logger.info(`📈 Opening price set for ${symbol}: ₹${open.toFixed(2)}`);
      }

      // Update high and low from API data (API already tracks day high/low)
      const prevHigh = tracking.high;
      const prevLow = tracking.low;

      tracking.high = Math.max(tracking.high, high);
      tracking.low = tracking.low === Infinity ? low : Math.min(tracking.low, low);

      // Log when high or low changes
      if (tracking.high !== prevHigh) {
        logger.info(`🔼 NEW HIGH for ${symbol}: ₹${tracking.high.toFixed(2)} (was ₹${prevHigh.toFixed(2)})`);
      }
      if (tracking.low !== prevLow && prevLow !== Infinity) {
        logger.info(`🔽 NEW LOW for ${symbol}: ₹${tracking.low.toFixed(2)} (was ₹${prevLow.toFixed(2)})`);
      }

      // Create market data with OHLC from API
      const marketData: MarketData = {
        symbol: symbol,
        ltp: ltp,
        open: tracking.open,
        high: tracking.high,
        low: tracking.low,
        close: ltp, // Current price is the "close"
        volume: 0, // Not available from OHLC mode
        timestamp: new Date()
      };

      // Emit market data event
      this.emit('market_data', marketData);

      logger.info(`📊 Market data: ${symbol}`, {
        ltp: `₹${marketData.ltp.toFixed(2)}`,
        high: `₹${marketData.high.toFixed(2)}`,
        low: `₹${marketData.low.toFixed(2)}`,
        open: `₹${marketData.open.toFixed(2)}`
      });

    } catch (error: any) {
      // Don't spam errors, just log once
      if (error.message?.includes('401') || error.message?.includes('Unauthorized')) {
        logger.error(`Authentication error for ${symbol} - check Angel One credentials`);
      } else {
        logger.debug(`Failed to process ${symbol}: ${error.message}`);
      }
    }
  }

  public resetDailyData(): void {
    // Reset all price tracking for new trading day
    for (const tracking of this.priceTracking.values()) {
      tracking.open = 0;
      tracking.high = 0;
      tracking.low = Infinity;
      tracking.lastClose = 0;
    }
    logger.info('📅 Daily price tracking data reset');
  }

  public addSymbol(symbol: string): void {
    if (!this.symbols.includes(symbol)) {
      this.symbols.push(symbol);
      this.priceTracking.set(symbol, {
        open: 0,
        high: 0,
        low: Infinity,
        lastClose: 0
      });
      logger.info(`Added symbol to market data fetcher`, { symbol });
    }
  }

  public removeSymbol(symbol: string): void {
    this.symbols = this.symbols.filter(s => s !== symbol);
    this.priceTracking.delete(symbol);
    logger.info(`Removed symbol from market data fetcher`, { symbol });
  }

  public getSymbols(): string[] {
    return [...this.symbols];
  }
}
