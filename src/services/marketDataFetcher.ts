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

  constructor(client: AngelOneClient, watchlist: string[] = []) {
    super();
    this.client = client;
    this.symbols = watchlist.length > 0 ? watchlist : this.getDefaultWatchlist();
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

    logger.info('✅ Market data fetcher stopped');
  }

  private async fetchAllMarketData(): Promise<void> {
    try {
      // Get tokens for all symbols dynamically
      const tokensMap = await symbolTokenService.getTokens(this.symbols);
      const tokens = Array.from(tokensMap.values());

      if (tokens.length === 0) {
        logger.debug('Symbol tokens not yet loaded, skipping this fetch cycle');
        return;
      }

      // Prepare exchangeTokens for batch request
      const exchangeTokens: { [key: string]: string[] } = {
        'NSE': tokens
      };

      // Fetch all market data in one API call
      const marketData = await this.client.getMarketData('OHLC', exchangeTokens);

      if (!marketData || !marketData.fetched) {
        logger.warn('No market data received from API');
        return;
      }

      // Process each symbol's data
      for (const symbol of this.symbols) {
        const token = tokensMap.get(symbol);
        if (!token) {
          logger.warn(`No token found for ${symbol}`);
          continue;
        }

        const symbolData = marketData.fetched.find((item: any) => item.symbolToken === token);
        if (symbolData) {
          this.processSymbolData(symbol, symbolData);
        } else {
          logger.warn(`No data received for ${symbol}`);
        }
      }
    } catch (error) {
      logger.error('Error fetching market data batch', error);
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

      if (!ltp) {
        logger.warn(`No price data for ${symbol}`);
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
