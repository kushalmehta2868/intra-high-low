import * as cron from 'node-cron';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

export class MarketScheduler extends EventEmitter {
  private marketStartTime: string;
  private marketEndTime: string;
  private autoSquareOffTime: string;
  private marketStartJob: cron.ScheduledTask | null = null;
  private marketEndJob: cron.ScheduledTask | null = null;
  private squareOffJob: cron.ScheduledTask | null = null;
  private priceUpdateJob: cron.ScheduledTask | null = null;
  private readonly IST_TIMEZONE = 'Asia/Kolkata';

  constructor(marketStartTime: string, marketEndTime: string, autoSquareOffTime: string) {
    super();
    this.marketStartTime = marketStartTime;
    this.marketEndTime = marketEndTime;
    this.autoSquareOffTime = autoSquareOffTime;
  }

  public start(): void {
    this.scheduleMarketStart();
    this.scheduleMarketEnd();
    this.scheduleAutoSquareOff();
    this.schedulePriceUpdates();

    // Get current time in IST for logging
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: this.IST_TIMEZONE }));
    const currentIstTime = istTime.toLocaleString('en-IN', {
      timeZone: this.IST_TIMEZONE,
      hour12: false
    });

    logger.info('Market scheduler started', {
      timezone: this.IST_TIMEZONE,
      currentISTTime: currentIstTime,
      marketStartTime: `${this.marketStartTime} IST`,
      marketEndTime: `${this.marketEndTime} IST`,
      autoSquareOffTime: `${this.autoSquareOffTime} IST`,
      isMarketHours: this.isMarketHours()
    });

    this.emit('scheduler_started');
  }

  private scheduleMarketStart(): void {
    const [hour, minute] = this.marketStartTime.split(':');
    const cronExpression = `${minute} ${hour} * * 1-5`;

    this.marketStartJob = cron.schedule(cronExpression, () => {
      logger.info('Market opened');
      this.emit('market_open');
    }, {
      timezone: this.IST_TIMEZONE
    });
  }

  private scheduleMarketEnd(): void {
    const [hour, minute] = this.marketEndTime.split(':');
    const cronExpression = `${minute} ${hour} * * 1-5`;

    this.marketEndJob = cron.schedule(cronExpression, () => {
      logger.info('Market closed');
      this.emit('market_close');
    }, {
      timezone: this.IST_TIMEZONE
    });
  }

  private scheduleAutoSquareOff(): void {
    const [hour, minute] = this.autoSquareOffTime.split(':');
    const cronExpression = `${minute} ${hour} * * 1-5`;

    this.squareOffJob = cron.schedule(cronExpression, () => {
      logger.info('Auto square-off time reached');
      this.emit('auto_square_off');
    }, {
      timezone: this.IST_TIMEZONE
    });
  }

  private schedulePriceUpdates(): void {
    this.priceUpdateJob = cron.schedule('*/5 * * * * *', () => {
      if (this.isMarketHours()) {
        this.emit('update_prices');
      }
    });
  }

  public isMarketHours(): boolean {
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

  public isAfterSquareOffTime(): boolean {
    // Get current time in IST
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: this.IST_TIMEZONE }));
    const currentTime = `${String(istTime.getHours()).padStart(2, '0')}:${String(istTime.getMinutes()).padStart(2, '0')}`;

    return currentTime >= this.autoSquareOffTime;
  }

  public stop(): void {
    if (this.marketStartJob) this.marketStartJob.stop();
    if (this.marketEndJob) this.marketEndJob.stop();
    if (this.squareOffJob) this.squareOffJob.stop();
    if (this.priceUpdateJob) this.priceUpdateJob.stop();

    logger.info('Market scheduler stopped');
    this.emit('scheduler_stopped');
  }

  public updateTimes(marketStart?: string, marketEnd?: string, squareOff?: string): void {
    if (marketStart) this.marketStartTime = marketStart;
    if (marketEnd) this.marketEndTime = marketEnd;
    if (squareOff) this.autoSquareOffTime = squareOff;

    this.stop();
    this.start();

    logger.info('Market scheduler times updated', {
      marketStartTime: this.marketStartTime,
      marketEndTime: this.marketEndTime,
      autoSquareOffTime: this.autoSquareOffTime
    });
  }
}
