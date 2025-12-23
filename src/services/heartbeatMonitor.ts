import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

/**
 * HeartbeatMonitor - Detects when market data feed goes silent
 *
 * Critical for detecting:
 * - WebSocket disconnections
 * - API failures
 * - Network issues
 *
 * Prevents silent failures where bot appears to run but misses all data
 */
export class HeartbeatMonitor extends EventEmitter {
  private lastDataTimestamp: number = 0;
  private monitorInterval: NodeJS.Timeout | null = null;
  private readonly ALERT_THRESHOLD_MS = 60000; // Alert if no data for 1 minute
  private readonly CHECK_INTERVAL_MS = 10000; // Check every 10 seconds
  private lastAlertTime: number = 0;
  private isFirstData: boolean = true;

  public start(): void {
    logger.info('🫀 Heartbeat monitor started', {
      alertThreshold: `${this.ALERT_THRESHOLD_MS / 1000} seconds`,
      checkInterval: `${this.CHECK_INTERVAL_MS / 1000} seconds`
    });

    this.monitorInterval = setInterval(() => {
      this.checkHeartbeat();
    }, this.CHECK_INTERVAL_MS);
  }

  private checkHeartbeat(): void {
    // Don't check until we've received first data
    if (this.isFirstData) {
      return;
    }

    const now = Date.now();
    const timeSinceData = now - this.lastDataTimestamp;

    if (timeSinceData > this.ALERT_THRESHOLD_MS) {
      // Don't spam alerts - only every 5 minutes
      if (now - this.lastAlertTime > 300000) {
        logger.error('💔 NO DATA RECEIVED - DATA FEED DEAD', {
          lastDataAgo: `${Math.floor(timeSinceData / 1000)} seconds`,
          threshold: `${this.ALERT_THRESHOLD_MS / 1000} seconds`,
          lastDataTime: new Date(this.lastDataTimestamp).toLocaleTimeString('en-IN')
        });

        this.emit('data_feed_dead', { timeSinceData });
        this.lastAlertTime = now;
      }
    }
  }

  public stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      logger.info('🫀 Heartbeat monitor stopped');
    }
  }

  /**
   * Call this every time market data is received
   */
  public recordDataReceived(): void {
    const now = Date.now();

    if (this.isFirstData) {
      this.isFirstData = false;
      logger.info('🫀 First market data received - heartbeat monitoring active');
    }

    this.lastDataTimestamp = now;
  }

  /**
   * Get time since last data (for monitoring)
   */
  public getTimeSinceLastData(): number {
    if (this.lastDataTimestamp === 0) {
      return 0;
    }
    return Date.now() - this.lastDataTimestamp;
  }

  /**
   * Check if data feed is alive
   */
  public isDataFeedAlive(): boolean {
    if (this.lastDataTimestamp === 0) {
      return true; // Not started yet
    }
    return this.getTimeSinceLastData() < this.ALERT_THRESHOLD_MS;
  }
}
