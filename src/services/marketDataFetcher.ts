import { EventEmitter } from 'events';
import { AngelOneClient } from '../brokers/angelone/client';
import { MarketData } from '../types';
import { logger } from '../utils/logger';

interface SymbolPriceTracking {
  open: number;
  high: number;
  low: number;
  lastClose: number;
}

export class MarketDataFetcher extends EventEmitter {
  private client: AngelOneClient;
  private symbols: Map<string, string> = new Map(); // symbol -> token
  private priceTracking: Map<string, SymbolPriceTracking> = new Map(); // Track OHLC
  private isRunning: boolean = false;
  private fetchInterval: NodeJS.Timeout | null = null;
  private readonly FETCH_INTERVAL_MS = 5000; // Fetch every 5 seconds

  constructor(client: AngelOneClient) {
    super();
    this.client = client;
    this.initializeSymbolTokens();
  }

  private initializeSymbolTokens(): void {
    // NSE symbol tokens
    this.symbols.set('RELIANCE-EQ', '2885');
    this.symbols.set('TCS-EQ', '11536');
    this.symbols.set('INFY-EQ', '1594');
    this.symbols.set('HDFCBANK-EQ', '1333');
    this.symbols.set('ICICIBANK-EQ', '4963');
    this.symbols.set('TRENT-EQ', '1964');
    this.symbols.set('ULTRACEMCO-EQ', '11532');
    this.symbols.set('MUTHOOTFIN-EQ', '23650');
    this.symbols.set('COFORGE-EQ', '11543');
    this.symbols.set('ABB-EQ', '13');
    this.symbols.set('ALKEM-EQ', '11703');
    this.symbols.set('AMBER-EQ', '1185');
    this.symbols.set('ANGELONE-EQ', '324');
    this.symbols.set('APOLLOHOSP-EQ', '157');
    this.symbols.set('BAJAJ-AUTO-EQ', '16669');
    this.symbols.set('BHARTIARTL-EQ', '10604');
    this.symbols.set('BRITANNIA-EQ', '547');
    this.symbols.set('BSE-EQ', '19585');
    this.symbols.set('CUMMINSIND-EQ', '1901');
    this.symbols.set('DIXON-EQ', '21690');
    this.symbols.set('GRASIM-EQ', '1232');
    this.symbols.set('HAL-EQ', '2303');
    this.symbols.set('HDFCAMC-EQ', '4244');
    this.symbols.set('HEROMOTOCO-EQ', '1348');

    // Initialize price tracking for each symbol
    for (const symbol of this.symbols.keys()) {
      this.priceTracking.set(symbol, {
        open: 0,
        high: 0,
        low: Infinity,
        lastClose: 0
      });
    }

    logger.info('Market data symbols initialized', {
      symbols: Array.from(this.symbols.keys())
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
      // Prepare exchangeTokens for batch request
      const exchangeTokens: { [key: string]: string[] } = {
        'NSE': Array.from(this.symbols.values())
      };

      // Fetch all market data in one API call
      const marketData = await this.client.getMarketData('OHLC', exchangeTokens);

      if (!marketData || !marketData.fetched) {
        logger.warn('No market data received from API');
        return;
      }

      // Process each symbol's data
      for (const [symbol, token] of this.symbols) {
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

  public addSymbol(symbol: string, token: string): void {
    this.symbols.set(symbol, token);
    this.priceTracking.set(symbol, {
      open: 0,
      high: 0,
      low: Infinity,
      lastClose: 0
    });
    logger.info(`Added symbol to market data fetcher`, { symbol, token });
  }

  public removeSymbol(symbol: string): void {
    this.symbols.delete(symbol);
    this.priceTracking.delete(symbol);
    logger.info(`Removed symbol from market data fetcher`, { symbol });
  }

  public getSymbols(): string[] {
    return Array.from(this.symbols.keys());
  }
}
