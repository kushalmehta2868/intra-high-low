import * as cron from 'node-cron';
import { Candle } from '../types';
import { logger } from '../utils/logger';
import { symbolTokenService } from './symbolTokenService';

export type RawCandle = [string, number, number, number, number, number];

/** Any object that can fetch raw OHLCV data from Angel One (broker duck-type). */
export interface ICandleDataProvider {
  getCandleData(
    exchange: string,
    symboltoken: string,
    interval: string,
    fromdate: string,
    todate: string,
  ): Promise<RawCandle[] | null>;
}

export interface CandleBundle {
  fifteenMin: Candle[];   // last ~50 × 15-min candles (oldest-first)
  oneHour:    Candle[];   // last ~25 × 1H candles    (oldest-first)
}

export type CandleUpdateHandler = (symbol: string, bundle: CandleBundle) => void;

/**
 * CandleDataService
 *
 * Fetches and caches 15-min and 1-H candles for every watchlist symbol
 * using the Angel One historical data API.
 *
 * Refresh schedule (IST):
 *   • 15-min candles  – at :01, :16, :31, :46 past every hour
 *     (1 minute after each 15-min candle close, e.g. 9:31, 9:46, 10:01 …)
 *   • 1-H candles     – at :17 past every hour
 *     (2 minutes after each 1-H candle close)
 *
 * Registered handlers are called after each successful refresh.
 */
export class CandleDataService {
  private provider: ICandleDataProvider;
  private watchlist: string[] = [];
  private cache: Map<string, CandleBundle> = new Map();
  private handlers: CandleUpdateHandler[] = [];
  private tasks: cron.ScheduledTask[] = [];
  private isRunning = false;

  constructor(provider: ICandleDataProvider) {
    this.provider = provider;
  }

  /** Register a callback that fires after every candle refresh. */
  onCandlesUpdated(handler: CandleUpdateHandler): void {
    this.handlers.push(handler);
  }

  /** Start refreshing candles on schedule for the given symbols. */
  async start(watchlist: string[]): Promise<void> {
    this.watchlist = watchlist;
    this.isRunning = true;

    // Warm up the cache immediately so strategies have data from the first tick
    await this.refreshAll();

    // 15-min refresh: 1 min after each 15-min candle close
    const task15 = cron.schedule('1,16,31,46 * * * *', async () => {
      if (!this.isInTradingHours()) return;
      await this.refreshAll('FIFTEEN_MINUTE');
    }, { timezone: 'Asia/Kolkata' });

    // 1-H refresh: 2 min after each 1-H candle close
    const task1h = cron.schedule('17 * * * *', async () => {
      if (!this.isInTradingHours()) return;
      await this.refreshAll('ONE_HOUR');
    }, { timezone: 'Asia/Kolkata' });

    this.tasks.push(task15, task1h);
    logger.info('CandleDataService started', { symbols: watchlist.length });
  }

  stop(): void {
    this.isRunning = false;
    for (const t of this.tasks) t.stop();
    this.tasks = [];
    logger.info('CandleDataService stopped');
  }

  /** Get cached bundle for a symbol (may be undefined if not yet fetched). */
  getBundle(symbol: string): CandleBundle | undefined {
    return this.cache.get(symbol);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isInTradingHours(): boolean {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const h = now.getHours();
    const m = now.getMinutes();
    const minutes = h * 60 + m;
    return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 35; // 9:15 – 15:35 IST
  }

  /**
   * Refresh candles for every symbol.
   * @param only  If provided, only refresh that interval; otherwise refresh both.
   */
  private async refreshAll(only?: 'FIFTEEN_MINUTE' | 'ONE_HOUR'): Promise<void> {
    if (!this.isRunning) return;

    logger.info(`CandleDataService: refreshing ${only ?? 'all intervals'}`);

    for (const symbol of this.watchlist) {
      try {
        const token = await symbolTokenService.getToken(symbol);
        if (!token) {
          logger.warn(`CandleDataService: no token for ${symbol}`);
          continue;
        }

        const existing = this.cache.get(symbol) ?? { fifteenMin: [], oneHour: [] };

        if (!only || only === 'FIFTEEN_MINUTE') {
          const candles15 = await this.fetch('NSE', token, 'FIFTEEN_MINUTE', 7);
          if (candles15) existing.fifteenMin = candles15;
        }

        if (!only || only === 'ONE_HOUR') {
          const candles1h = await this.fetch('NSE', token, 'ONE_HOUR', 35);
          if (candles1h) existing.oneHour = candles1h;
        }

        this.cache.set(symbol, existing);

        // Notify registered strategies
        for (const handler of this.handlers) {
          try {
            handler(symbol, existing);
          } catch (err: any) {
            logger.error(`CandleDataService handler error for ${symbol}`, { error: err.message });
          }
        }

        // Small delay between symbols to stay inside Angel One rate limits
        await this.sleep(200);
      } catch (err: any) {
        logger.error(`CandleDataService: error refreshing ${symbol}`, { error: err.message });
      }
    }
  }

  /**
   * Fetch OHLCV candles and convert to the Candle type.
   * @param lookbackDays  How many calendar days to look back (covers weekends + holidays).
   */
  private async fetch(
    exchange: string,
    symboltoken: string,
    interval: string,
    lookbackDays: number,
  ): Promise<Candle[] | null> {
    const toIST  = this.nowIST();
    const fromIST = this.daysAgoIST(lookbackDays);

    const raw = await this.provider.getCandleData(
      exchange,
      symboltoken,
      interval,
      fromIST,
      toIST,
    );

    if (!raw || raw.length === 0) return null;

    return raw.map(([ts, open, high, low, close, volume]) => ({
      symbol: symboltoken,          // token; strategies don't use this field
      timestamp: new Date(ts),
      open,
      high,
      low,
      close,
      volume,
    }));
  }

  /** Current time in IST formatted as "YYYY-MM-DD HH:MM". */
  private nowIST(): string {
    return this.formatIST(new Date());
  }

  /** `n` calendar days ago in IST, at 09:00 (market open buffer). */
  private daysAgoIST(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    ist.setHours(9, 0, 0, 0);
    return this.formatIST(ist);
  }

  private formatIST(d: Date): string {
    const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const yyyy = ist.getFullYear();
    const mm   = String(ist.getMonth() + 1).padStart(2, '0');
    const dd   = String(ist.getDate()).padStart(2, '0');
    const hh   = String(ist.getHours()).padStart(2, '0');
    const min  = String(ist.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
