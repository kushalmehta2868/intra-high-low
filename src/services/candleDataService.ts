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
  fiveMin:   Candle[];   // last ~60 × 5-min candles  (oldest-first)
  tenMin:    Candle[];   // last ~50 × 10-min candles (oldest-first)
  thirtyMin: Candle[];   // last ~30 × 30-min candles (oldest-first)
}

export type CandleUpdateHandler = (symbol: string, bundle: CandleBundle) => void;

/**
 * CandleDataService
 *
 * Fetches and caches 5-min and 30-min candles for every watchlist symbol
 * using the Angel One historical data API.
 *
 * Refresh schedule (IST):
 *   • 5-min candles   – at :01,:06,:11,:16,:21,:26,:31,:36,:41,:46,:51,:56 past every hour
 *     (1 minute after each 5-min candle close)
 *   • 30-min candles  – at :01 and :31 past every hour
 *     (1 minute after each 30-min candle close)
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

    // 5-min refresh: 1 min after each 5-min candle close
    const task5 = cron.schedule('1,6,11,16,21,26,31,36,41,46,51,56 * * * *', async () => {
      if (!this.isInTradingHours()) return;
      await this.refreshAll('FIVE_MINUTE');
    }, { timezone: 'Asia/Kolkata' });

    // 10-min refresh: 1 min after each 10-min candle close
    const task10 = cron.schedule('1,11,21,31,41,51 * * * *', async () => {
      if (!this.isInTradingHours()) return;
      await this.refreshAll('TEN_MINUTE');
    }, { timezone: 'Asia/Kolkata' });

    // 30-min refresh: 1 min after each 30-min candle close
    const task30 = cron.schedule('1,31 * * * *', async () => {
      if (!this.isInTradingHours()) return;
      await this.refreshAll('THIRTY_MINUTE');
    }, { timezone: 'Asia/Kolkata' });

    this.tasks.push(task5, task10, task30);
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
  private async refreshAll(only?: 'FIVE_MINUTE' | 'TEN_MINUTE' | 'THIRTY_MINUTE'): Promise<void> {
    if (!this.isRunning) return;

    logger.info(`CandleDataService: refreshing ${only ?? 'all intervals'}`);

    // Auth probe: try the first symbol before processing the whole watchlist.
    // If the broker has no valid JWT, abort immediately instead of hammering
    // the login endpoint once per symbol (which triggers the rate-limit cooldown).
    const probeToken = await symbolTokenService.getToken(this.watchlist[0]);
    if (probeToken) {
      const probe = await this.provider.getCandleData('NSE', probeToken, 'FIVE_MINUTE',
        this.daysAgoIST(1), this.nowIST());
      if (probe === null) {
        logger.warn('CandleDataService: auth probe failed — skipping refresh until next cycle');
        return;
      }
    }

    for (const symbol of this.watchlist) {
      try {
        const token = await symbolTokenService.getToken(symbol);
        if (!token) {
          logger.warn(`CandleDataService: no token for ${symbol}`);
          continue;
        }

        const existing = this.cache.get(symbol) ?? { fiveMin: [], tenMin: [], thirtyMin: [] };

        if (!only || only === 'FIVE_MINUTE') {
          const candles5 = await this.fetch('NSE', token, 'FIVE_MINUTE', 3);
          if (candles5) existing.fiveMin = candles5;
        }

        if (!only || only === 'TEN_MINUTE') {
          const candles10 = await this.fetch('NSE', token, 'TEN_MINUTE', 3);
          if (candles10) existing.tenMin = candles10;
        }

        if (!only || only === 'THIRTY_MINUTE') {
          const candles30 = await this.fetch('NSE', token, 'THIRTY_MINUTE', 7);
          if (candles30) existing.thirtyMin = candles30;
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
        await this.sleep(300);
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
