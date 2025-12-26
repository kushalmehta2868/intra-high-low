import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { AngelOneClient } from '../brokers/angelone/client';
import { MarketData } from '../types';
import { logger } from '../utils/logger';
import { symbolTokenService } from './symbolTokenService';
import { holidayCalendar } from './holidayCalendar';

interface WebSocketConfig {
  url: string;
  reconnectDelay: number;
  maxReconnectAttempts: number;
  heartbeatInterval: number;
}

interface SubscriptionData {
  symbol: string;
  token: string;
  mode: 'LTP' | 'QUOTE' | 'SNAP_QUOTE';
}

/**
 * WebSocket Market Data Feed - Real-time streaming data from Angel One
 * Replaces inefficient polling with live WebSocket connection
 */
export class WebSocketDataFeed extends EventEmitter {
  private client: AngelOneClient;
  private ws: WebSocket | null = null;
  private subscriptions: Map<string, SubscriptionData> = new Map();
  private priceTracking: Map<string, any> = new Map();
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // Authentication credentials
  private authToken: string | null = null;
  private feedToken: string | null = null;
  private clientCode: string | null = null;

  // Logging throttle - log market data every 10 seconds
  private lastLogTime: Map<string, number> = new Map();
  private readonly LOG_INTERVAL_MS = 10000; // 10 seconds
  private tickCount: number = 0; // Count total ticks received
  private lastSummaryTime: number = 0; // Last time we logged summary

  // Market hours control
  private readonly IST_TIMEZONE = 'Asia/Kolkata';
  private marketStartTime: string = '09:15';
  private marketEndTime: string = '15:30';

  private config: WebSocketConfig = {
    url: 'wss://smartapisocket.angelone.in/smart-stream',
    reconnectDelay: 5000,
    maxReconnectAttempts: 10,
    heartbeatInterval: 30000
  };

  constructor(client: AngelOneClient, marketStartTime?: string, marketEndTime?: string) {
    super();
    this.client = client;
    if (marketStartTime) this.marketStartTime = marketStartTime;
    if (marketEndTime) this.marketEndTime = marketEndTime;
  }

  /**
   * Connect to WebSocket feed
   */
  public async connect(): Promise<boolean> {
    try {
      logger.info('🔌 Connecting to WebSocket market data feed...', {
        url: this.config.url
      });

      // Get auth token from client
      const authToken = this.client.getAuthToken();
      const feedToken = this.client.getFeedToken();
      const clientCode = this.client.getClientCode();

      logger.info('🔑 Checking authentication credentials', {
        hasAuthToken: !!authToken,
        hasFeedToken: !!feedToken,
        hasClientCode: !!clientCode,
        clientCode: clientCode
      });

      if (!authToken || !feedToken || !clientCode) {
        logger.error('❌ Missing authentication credentials for WebSocket', {
          authToken: !!authToken,
          feedToken: !!feedToken,
          clientCode: !!clientCode
        });
        return false;
      }

      // Store credentials for auth message after connection
      this.authToken = authToken;
      this.feedToken = feedToken;
      this.clientCode = clientCode;

      // Create WebSocket connection with promise to wait for connection
      return new Promise((resolve, reject) => {
        try {
          // CRITICAL: Angel One WebSocket authentication via URL parameters
          // Format: wss://smartapisocket.angelone.in/smart-stream?jwtToken=xxx&apiKey=yyy&clientCode=zzz&feedToken=www
          const wsUrl = `${this.config.url}?jwtToken=${authToken}&apiKey=${authToken}&clientCode=${clientCode}&feedToken=${feedToken}`;

          logger.info('🔌 Creating WebSocket connection with auth parameters', {
            baseUrl: this.config.url,
            clientCode: clientCode,
            hasAuthToken: !!authToken,
            hasFeedToken: !!feedToken
          });

          // Create WebSocket with auth parameters in URL
          this.ws = new WebSocket(wsUrl);

          // Set timeout for connection
          const connectionTimeout = setTimeout(() => {
            logger.error('❌ WebSocket connection timeout after 30 seconds');
            if (this.ws) {
              this.ws.close();
            }
            resolve(false);
          }, 30000);

          this.ws.on('open', () => {
            clearTimeout(connectionTimeout);
            this.handleOpen();
            resolve(true);
          });

          this.ws.on('message', (data: WebSocket.Data) => {
            this.handleMessage(data);
          });

          this.ws.on('error', (error: Error) => {
            clearTimeout(connectionTimeout);
            this.handleError(error);
            resolve(false);
          });

          this.ws.on('close', (code: number, reason: string) => {
            clearTimeout(connectionTimeout);
            this.handleClose(code, reason);
          });

        } catch (err: any) {
          logger.error('❌ Error creating WebSocket connection', err);
          resolve(false);
        }
      });

    } catch (error: any) {
      logger.error('❌ Error in WebSocket connect method', error);
      return false;
    }
  }

  /**
   * Handle WebSocket connection open
   */
  private handleOpen(): void {
    logger.info('✅ WebSocket connected to Angel One');
    this.isConnected = true;
    this.reconnectAttempts = 0;

    // Initialize summary timer
    this.lastSummaryTime = Date.now();
    this.tickCount = 0;

    // CRITICAL: Angel One WebSocket authentication protocol
    // After connection, send authentication message with client credentials
    // This is the CORRECT way - NOT via headers during connection
    const authMessage = {
      action: 1, // Subscribe action
      params: {
        mode: 3, // SNAP_QUOTE mode (full OHLC data)
        tokenList: [{
          exchangeType: 1, // NSE
          tokens: [] // Empty for initial auth
        }]
      }
    };

    logger.info('🔐 Sending authentication message to WebSocket', {
      action: authMessage.action,
      mode: authMessage.params.mode,
      clientCode: this.clientCode,
      hasFeedToken: !!this.feedToken,
      hasAuthToken: !!this.authToken
    });

    this.send(authMessage);

    // Start heartbeat
    this.startHeartbeat();

    this.emit('connected');
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as any);

      // Use debug for high-frequency data logging
      logger.debug('📥 WebSocket data received', {
        length: buffer.length,
        isBinary: Buffer.isBuffer(data)
      });

      // Try parsing as JSON first (for control messages)
      try {
        const jsonString = buffer.toString('utf8');
        const message = JSON.parse(jsonString);

        logger.info('📦 Parsed JSON control message', {
          type: message.type,
          action: message.action,
          keys: Object.keys(message)
        });

        if (message.type === 'tick') {
          this.processTickMessage(message.data);
        } else if (message.type === 'error') {
          logger.error('WebSocket error message', message);
        } else {
          logger.info('Control message received', message);
        }
      } catch (parseError) {
        // Not JSON - parse as binary tick data (this is the most common path)
        this.parseBinaryTick(buffer);
      }

    } catch (error: any) {
      logger.error('Error handling WebSocket message', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Parse binary tick data from Angel One SmartAPI WebSocket V2
   * Binary format documentation: https://github.com/angel-one/smartapi-python/blob/main/SmartApi/smartWebSocketV2.py
   */
  private parseBinaryTick(data: Buffer): void {
    try {
      // Minimum length check - need at least 123 bytes for OHLC data
      if (data.length < 123) {
        logger.warn('⚠️ Binary data too short for OHLC parsing', {
          length: data.length,
          required: 123
        });
        return;
      }

      // Extract token (bytes 2-27, null-terminated string)
      let token = '';
      for (let i = 2; i < 27; i++) {
        if (data[i] === 0) break; // Null terminator
        token += String.fromCharCode(data[i]);
      }

      // Extract market data using little-endian format (<)
      // Prices are in paise (divide by 100 to get rupees)
      const subscriptionMode = data.readUInt8(0);
      const exchangeType = data.readUInt8(1);
      const ltp = data.readBigInt64LE(43) / 100n; // Bytes 43-51
      const open = data.readBigInt64LE(91) / 100n; // Bytes 91-99
      const high = data.readBigInt64LE(99) / 100n; // Bytes 99-107
      const low = data.readBigInt64LE(107) / 100n; // Bytes 107-115
      const close = data.readBigInt64LE(115) / 100n; // Bytes 115-123

      // Extract volume (bytes 27-35, 8-byte integer)
      // Volume is typically cumulative for the day
      let volume = 0;
      if (data.length >= 35) {
        try {
          volume = Number(data.readBigInt64LE(27));
        } catch (e) {
          logger.debug('Could not read volume from binary data');
        }
      }

      // Convert BigInt to Number for market data
      const ltpNum = Number(ltp);
      const openNum = Number(open);
      const highNum = Number(high);
      const lowNum = Number(low);
      const closeNum = Number(close);

      // Use debug for high-frequency tick data
      logger.debug('📊 Binary tick parsed', {
        token,
        mode: subscriptionMode,
        ltp: `₹${ltpNum.toFixed(2)}`,
        high: `₹${highNum.toFixed(2)}`,
        low: `₹${lowNum.toFixed(2)}`,
        volume
      });

      // Find symbol for this token
      let symbol: string | undefined;
      for (const sub of this.subscriptions.values()) {
        if (sub.token === token) {
          symbol = sub.symbol;
          break;
        }
      }

      if (symbol) {
        this.tickCount++; // Increment tick counter
        this.emitMarketData(symbol, ltpNum, openNum, highNum, lowNum, volume);
      } else {
        logger.warn('⚠️ Token not found in subscriptions', {
          token,
          subscribedTokens: Array.from(this.subscriptions.values()).map(s => s.token)
        });
      }

    } catch (error: any) {
      logger.error('❌ Error parsing binary tick', {
        error: error.message,
        stack: error.stack,
        dataLength: data.length
      });
    }
  }

  /**
   * Process tick message (JSON format)
   */
  private processTickMessage(tickData: any): void {
    try {
      const ticks = Array.isArray(tickData) ? tickData : [tickData];

      for (const tick of ticks) {
        const token = tick.token || tick.symbolToken;

        // Find symbol
        let symbol: string | undefined;
        for (const sub of this.subscriptions.values()) {
          if (sub.token === token) {
            symbol = sub.symbol;
            break;
          }
        }

        if (symbol && tick.ltp) {
          logger.info('📈 Tick data received', {
            symbol,
            ltp: tick.ltp,
            open: tick.open,
            high: tick.high,
            low: tick.low,
            volume: tick.volume || tick.vol || 0
          });

          this.emitMarketData(
            symbol,
            tick.ltp,
            tick.open || tick.ltp,
            tick.high || tick.ltp,
            tick.low || tick.ltp,
            tick.volume || tick.vol || 0
          );
        }
      }
    } catch (error: any) {
      logger.error('Error processing tick message', error);
    }
  }

  /**
   * Check if current time is within market hours (IST timezone)
   * Excludes weekends, NSE holidays, and checks time range
   */
  private isMarketHours(): boolean {
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: this.IST_TIMEZONE }));

    // CRITICAL: Check if today is a trading day (excludes weekends and NSE holidays)
    if (!holidayCalendar.isTradingDay(now)) {
      return false;
    }

    const currentTime = `${String(istTime.getHours()).padStart(2, '0')}:${String(istTime.getMinutes()).padStart(2, '0')}`;

    return currentTime >= this.marketStartTime && currentTime <= this.marketEndTime;
  }

  /**
   * Emit market data event
   */
  private emitMarketData(symbol: string, ltp: number, open: number, high: number, low: number, volume: number = 0): void {
    // CRITICAL: Don't emit data outside market hours to conserve resources
    if (!this.isMarketHours()) {
      return; // Silently drop data outside market hours
    }

    // Get or create price tracking
    let tracking = this.priceTracking.get(symbol);
    if (!tracking) {
      tracking = {
        open: 0,
        high: 0,
        low: Infinity,
        lastClose: 0
      };
      this.priceTracking.set(symbol, tracking);
    }

    // Update tracking
    if (tracking.open === 0) {
      tracking.open = open;
    }
    tracking.high = Math.max(tracking.high, high);
    tracking.low = tracking.low === Infinity ? low : Math.min(tracking.low, low);

    const marketData: MarketData = {
      symbol,
      ltp,
      open: tracking.open,
      high: tracking.high,
      low: tracking.low,
      close: ltp,
      volume,
      timestamp: new Date()
    };

    this.emit('market_data', marketData);

    // Throttle logging - log every 10 seconds per symbol
    const now = Date.now();
    const lastLog = this.lastLogTime.get(symbol) || 0;

    if (now - lastLog >= this.LOG_INTERVAL_MS) {
      this.lastLogTime.set(symbol, now);

      const priceChange = tracking.open > 0 ? ((ltp - tracking.open) / tracking.open * 100) : 0;

      logger.info('📊 Market data update', {
        symbol,
        ltp: `₹${ltp.toFixed(2)}`,
        open: `₹${tracking.open.toFixed(2)}`,
        high: `₹${tracking.high.toFixed(2)}`,
        low: `₹${tracking.low.toFixed(2)}`,
        volume: volume > 0 ? volume.toLocaleString() : 'N/A',
        change: `${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%`
      });
    }

    // Log WebSocket summary every 10 seconds
    if (now - this.lastSummaryTime >= this.LOG_INTERVAL_MS) {
      const elapsedSeconds = (now - this.lastSummaryTime) / 1000;
      const tickRate = elapsedSeconds > 0 ? this.tickCount / elapsedSeconds : 0;

      logger.info('📡 WebSocket feed active', {
        ticksReceived: this.tickCount,
        subscribedSymbols: this.subscriptions.size,
        activeSymbols: this.priceTracking.size,
        tickRate: `${tickRate.toFixed(1)} ticks/sec`
      });

      // Reset counters for next interval
      this.lastSummaryTime = now;
      this.tickCount = 0;
    }
  }


  /**
   * Handle WebSocket errors
   */
  private handleError(error: Error): void {
    logger.error('❌ WebSocket error occurred', {
      message: error.message,
      code: (error as any).code,
      stack: error.stack
    });
    this.emit('error', error);
  }

  /**
   * Handle WebSocket connection close
   */
  private handleClose(code: number, reason: string): void {
    logger.warn('WebSocket connection closed', {
      code,
      reason: reason.toString()
    });

    this.isConnected = false;
    this.stopHeartbeat();

    this.emit('disconnected', { code, reason });

    // Attempt reconnection
    this.attemptReconnect();
  }

  /**
   * Subscribe to symbol
   */
  public async subscribe(symbol: string, mode: 'LTP' | 'QUOTE' | 'SNAP_QUOTE' = 'SNAP_QUOTE'): Promise<boolean> {
    try {
      // Get token for symbol
      const token = await symbolTokenService.getToken(symbol);
      if (!token) {
        logger.error('❌ Cannot subscribe - token not found', { symbol });
        return false;
      }

      const subscription: SubscriptionData = {
        symbol,
        token,
        mode
      };

      this.subscriptions.set(symbol, subscription);

      // Send subscription message if connected
      if (this.isConnected && this.ws) {
        const modeNum = mode === 'LTP' ? 1 : mode === 'QUOTE' ? 2 : 3;

        // Format matches working MarketDataService
        const subscribeMessage = {
          action: 1, // Subscribe action
          params: {
            mode: modeNum,
            tokenList: [{
              exchangeType: 1, // NSE
              tokens: [token]
            }]
          }
        };

        logger.info('📡 Subscribing to symbol via WebSocket', {
          symbol,
          token,
          mode,
          modeNum,
          message: subscribeMessage
        });

        this.send(subscribeMessage);

        logger.info('✅ Subscribed to symbol', { symbol, token, mode });
      } else {
        logger.warn('⚠️ WebSocket not connected, subscription queued', { symbol });
      }

      return true;

    } catch (error: any) {
      logger.error('❌ Error subscribing to symbol', { symbol, error: error.message });
      return false;
    }
  }

  /**
   * Subscribe to multiple symbols
   */
  public async subscribeMultiple(symbols: string[], mode: 'LTP' | 'QUOTE' | 'SNAP_QUOTE' = 'SNAP_QUOTE'): Promise<void> {
    logger.info('📡 Subscribing to multiple symbols', {
      count: symbols.length,
      mode
    });

    for (const symbol of symbols) {
      await this.subscribe(symbol, mode);
    }
  }

  /**
   * Unsubscribe from symbol
   */
  public async unsubscribe(symbol: string): Promise<void> {
    const subscription = this.subscriptions.get(symbol);
    if (!subscription) {
      return;
    }

    if (this.isConnected && this.ws) {
      const unsubscribeMessage = {
        a: 'unsubscribe',
        v: [[1, subscription.token]]
      };

      this.send(unsubscribeMessage);
    }

    this.subscriptions.delete(symbol);
    this.priceTracking.delete(symbol);

    logger.info('📴 Unsubscribed from symbol', { symbol });
  }

  /**
   * Resubscribe to all symbols (after reconnection)
   */
  private resubscribeAll(): void {
    if (this.subscriptions.size === 0) {
      logger.warn('⚠️ No subscriptions to resubscribe');
      return;
    }

    logger.info('🔄 Resubscribing to all symbols', {
      count: this.subscriptions.size,
      symbols: Array.from(this.subscriptions.keys())
    });

    const tokenList: string[] = [];
    let modeNum = 3; // Default to SNAP_QUOTE

    for (const sub of this.subscriptions.values()) {
      tokenList.push(sub.token);
      modeNum = sub.mode === 'LTP' ? 1 : sub.mode === 'QUOTE' ? 2 : 3;
      logger.debug(`Adding to subscription list: ${sub.symbol} (token: ${sub.token}, mode: ${modeNum})`);
    }

    // Format matches working MarketDataService
    const subscribeMessage = {
      action: 1,
      params: {
        mode: modeNum,
        tokenList: [{
          exchangeType: 1, // NSE
          tokens: tokenList
        }]
      }
    };

    logger.info('📤 Sending batch subscription message', {
      subscriptionCount: tokenList.length,
      message: subscribeMessage
    });

    this.send(subscribeMessage);
  }

  /**
   * Send message to WebSocket
   */
  private send(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      logger.warn('Cannot send message - WebSocket not connected');
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ a: 'heartbeat', v: [] });
        logger.debug('💓 Heartbeat sent');
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Attempt to reconnect
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      logger.warn('⚠️ Max reconnection attempts reached - resetting counter and continuing', {
        attempts: this.reconnectAttempts,
        max: this.config.maxReconnectAttempts
      });

      // CRITICAL FIX: Reset reconnect attempts and use exponential backoff
      // Don't give up - keep trying with longer delays to prevent Render restarts
      this.reconnectAttempts = 0;

      // Use exponential backoff - wait longer before retrying
      const backoffDelay = this.config.reconnectDelay * 6; // 30 seconds

      logger.info('🔄 Will retry connection after extended delay', {
        delaySeconds: backoffDelay / 1000
      });

      this.reconnectTimer = setTimeout(() => {
        this.connect();
      }, backoffDelay);

      this.emit('max_reconnects_reached');
      return;
    }

    this.reconnectAttempts++;

    logger.info('🔄 Attempting to reconnect...', {
      attempt: this.reconnectAttempts,
      max: this.config.maxReconnectAttempts
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.config.reconnectDelay);
  }

  /**
   * Disconnect from WebSocket
   */
  public disconnect(): void {
    logger.info('Disconnecting from WebSocket...');

    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      // Remove all event listeners to prevent memory leaks
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.subscriptions.clear();
    this.priceTracking.clear();

    // Remove all event listeners from this EventEmitter
    this.removeAllListeners();

    logger.info('✅ WebSocket disconnected and cleaned up');
  }

  /**
   * Check if connected
   */
  public isActive(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get subscription list
   */
  public getSubscriptions(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  /**
   * Reset daily data
   */
  public resetDailyData(): void {
    for (const tracking of this.priceTracking.values()) {
      tracking.open = 0;
      tracking.high = 0;
      tracking.low = Infinity;
      tracking.lastClose = 0;
    }
    logger.info('📅 WebSocket daily data reset');
  }

  /**
   * Get statistics
   */
  public getStatistics() {
    return {
      connected: this.isConnected,
      subscriptions: this.subscriptions.size,
      reconnectAttempts: this.reconnectAttempts
    };
  }
}
