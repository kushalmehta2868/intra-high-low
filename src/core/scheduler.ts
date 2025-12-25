import * as cron from 'node-cron';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { holidayCalendar } from '../services/holidayCalendar';

export class MarketScheduler extends EventEmitter {
  private marketStartTime: string; // Data fetching starts (9:15 AM)
  private marketEndTime: string;   // Data fetching ends (3:30 PM)
  private autoSquareOffTime: string;
  private signalStartTime: string; // Signal generation starts (9:30 AM)
  private signalEndTime: string;   // Signal generation ends (3:00 PM)
  private marketStartJob: cron.ScheduledTask | null = null;
  private marketEndJob: cron.ScheduledTask | null = null;
  private squareOffJob: cron.ScheduledTask | null = null;
  private priceUpdateJob: cron.ScheduledTask | null = null;
  private dailySummaryJob: cron.ScheduledTask | null = null;
  private readonly IST_TIMEZONE = 'Asia/Kolkata';
  private readonly DAILY_SUMMARY_TIME = '17:00'; // 5 PM IST

  constructor(
    marketStartTime: string,
    marketEndTime: string,
    autoSquareOffTime: string,
    signalStartTime: string = '09:30',
    signalEndTime: string = '15:00'
  ) {
    super();
    this.marketStartTime = marketStartTime;
    this.marketEndTime = marketEndTime;
    this.autoSquareOffTime = autoSquareOffTime;
    this.signalStartTime = signalStartTime;
    this.signalEndTime = signalEndTime;
  }

  public start(): void {
    this.scheduleMarketStart();
    this.scheduleMarketEnd();
    this.scheduleAutoSquareOff();
    this.schedulePriceUpdates();
    this.scheduleDailySummary();

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
      dataFetchingHours: `${this.marketStartTime} - ${this.marketEndTime} IST`,
      signalGenerationHours: `${this.signalStartTime} - ${this.signalEndTime} IST`,
      autoSquareOffTime: `${this.autoSquareOffTime} IST`,
      isMarketHours: this.isMarketHours(),
      isSignalHours: this.isSignalGenerationHours()
    });

    this.emit('scheduler_started');
  }

  private scheduleMarketStart(): void {
    const [hour, minute] = this.marketStartTime.split(':');
    const cronExpression = `${minute} ${hour} * * 1-5`;

    this.marketStartJob = cron.schedule(cronExpression, () => {
      // CRITICAL: Don't emit market_open on holidays
      if (!holidayCalendar.isTradingDay()) {
        logger.info('Market start time reached, but today is NOT a trading day - skipping');
        return;
      }
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
      // CRITICAL: Don't emit market_close on holidays
      if (!holidayCalendar.isTradingDay()) {
        logger.info('Market end time reached, but today is NOT a trading day - skipping');
        return;
      }
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
      // CRITICAL: Don't emit auto_square_off on holidays
      if (!holidayCalendar.isTradingDay()) {
        logger.info('Auto square-off time reached, but today is NOT a trading day - skipping');
        return;
      }
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

  private scheduleDailySummary(): void {
    const [hour, minute] = this.DAILY_SUMMARY_TIME.split(':');
    const cronExpression = `${minute} ${hour} * * 1-5`; // Monday-Friday at 5 PM

    this.dailySummaryJob = cron.schedule(cronExpression, () => {
      // CRITICAL: Don't send daily summary on holidays
      if (!holidayCalendar.isTradingDay()) {
        logger.info('📊 Daily summary time reached, but today is NOT a trading day - skipping');
        return;
      }
      logger.info('📊 Daily summary time reached - sending report');
      this.emit('daily_summary');
    }, {
      timezone: this.IST_TIMEZONE
    });

    logger.info('📊 Daily summary scheduled', {
      time: `${this.DAILY_SUMMARY_TIME} IST`
    });
  }

  public isMarketHours(): boolean {
    // Check if market is open for DATA FETCHING (9:15 AM - 3:30 PM)
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: this.IST_TIMEZONE }));

    // CRITICAL: Check if today is a trading day (excludes weekends and holidays)
    if (!holidayCalendar.isTradingDay(now)) {
      return false;
    }

    const currentTime = `${String(istTime.getHours()).padStart(2, '0')}:${String(istTime.getMinutes()).padStart(2, '0')}`;

    return currentTime >= this.marketStartTime && currentTime <= this.marketEndTime;
  }

  public isSignalGenerationHours(): boolean {
    // Check if we should GENERATE SIGNALS (9:30 AM - 3:00 PM)
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: this.IST_TIMEZONE }));

    // CRITICAL: Check if today is a trading day (excludes weekends and holidays)
    if (!holidayCalendar.isTradingDay(now)) {
      return false;
    }

    const currentTime = `${String(istTime.getHours()).padStart(2, '0')}:${String(istTime.getMinutes()).padStart(2, '0')}`;

    return currentTime >= this.signalStartTime && currentTime <= this.signalEndTime;
  }

  public isAfterSquareOffTime(): boolean {
    // Get current time in IST
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: this.IST_TIMEZONE }));
    const currentTime = `${String(istTime.getHours()).padStart(2, '0')}:${String(istTime.getMinutes()).padStart(2, '0')}`;

    return currentTime >= this.autoSquareOffTime;
  }

  public stop(): void {
    if (this.marketStartJob) {
      this.marketStartJob.stop();
      this.marketStartJob = null;
    }
    if (this.marketEndJob) {
      this.marketEndJob.stop();
      this.marketEndJob = null;
    }
    if (this.squareOffJob) {
      this.squareOffJob.stop();
      this.squareOffJob = null;
    }
    if (this.priceUpdateJob) {
      this.priceUpdateJob.stop();
      this.priceUpdateJob = null;
    }
    if (this.dailySummaryJob) {
      this.dailySummaryJob.stop();
      this.dailySummaryJob = null;
    }

    // Remove all event listeners to prevent memory leaks
    this.removeAllListeners();

    logger.info('Market scheduler stopped and cleaned up');
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
