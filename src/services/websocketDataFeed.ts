import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { AngelOneClient } from '../brokers/angelone/client';
import { MarketData } from '../types';
import { logger } from '../utils/logger';
import { symbolTokenService } from './symbolTokenService';

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

  private config: WebSocketConfig = {
    url: 'wss://smartapisocket.angelone.in/smart-stream',
    reconnectDelay: 5000,
    maxReconnectAttempts: 10,
    heartbeatInterval: 30000
  };

  constructor(client: AngelOneClient) {
    super();
    this.client = client;
  }

  /**
   * Connect to WebSocket feed
   */
  public async connect(): Promise<boolean> {
    try {
      logger.info('🔌 Connecting to WebSocket market data feed...');

      // Get auth token from client
      const authToken = this.client.getAuthToken();
      const feedToken = this.client.getFeedToken();
      const clientCode = this.client.getClientCode();

      if (!authToken || !feedToken || !clientCode) {
        logger.error('Missing authentication credentials for WebSocket');
        return false;
      }

      // Create WebSocket connection
      this.ws = new WebSocket(this.config.url);

      this.ws.on('open', () => {
        this.handleOpen(authToken, feedToken, clientCode);
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error: Error) => {
        this.handleError(error);
      });

      this.ws.on('close', (code: number, reason: string) => {
        this.handleClose(code, reason);
      });

      return true;

    } catch (error: any) {
      logger.error('Error connecting to WebSocket', error);
      return false;
    }
  }

  /**
   * Handle WebSocket connection open
   */
  private handleOpen(authToken: string, feedToken: string, clientCode: string): void {
    logger.info('✅ WebSocket connected');
    this.isConnected = true;
    this.reconnectAttempts = 0;

    // Send authentication message
    const authMessage = {
      a: 'authorization',
      user: clientCode,
      token: authToken
    };

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
      const message = JSON.parse(data.toString());

      // Handle different message types
      if (message.t === 'ck' && message.s === 'OK') {
        logger.info('✅ WebSocket authenticated successfully');
        this.resubscribeAll();
      } else if (message.t === 'tk' || message.t === 'tf') {
        // Market data update
        this.processMarketData(message);
      } else if (message.t === 'er') {
        logger.error('WebSocket error message', message);
      }

    } catch (error: any) {
      logger.error('Error processing WebSocket message', error);
    }
  }

  /**
   * Process market data updates
   */
  private processMarketData(message: any): void {
    try {
      // Find subscription by token
      let subscription: SubscriptionData | undefined;
      for (const sub of this.subscriptions.values()) {
        if (sub.token === message.tk) {
          subscription = sub;
          break;
        }
      }

      if (!subscription) {
        return;
      }

      const symbol = subscription.symbol;

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

      // Parse market data based on mode
      const ltp = parseFloat(message.lp || message.c || 0);
      const open = parseFloat(message.o || tracking.open || ltp);
      const high = parseFloat(message.h || tracking.high || ltp);
      const low = parseFloat(message.l || tracking.low || ltp);
      const volume = parseInt(message.v || 0);

      // Update tracking
      if (tracking.open === 0) {
        tracking.open = open;
      }
      tracking.high = Math.max(tracking.high, high);
      tracking.low = tracking.low === Infinity ? low : Math.min(tracking.low, low);

      // Create market data object
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

      // Emit market data event
      this.emit('market_data', marketData);

      logger.debug(`📊 WebSocket data: ${symbol}`, {
        ltp: `₹${ltp.toFixed(2)}`,
        high: `₹${tracking.high.toFixed(2)}`,
        low: `₹${tracking.low.toFixed(2)}`
      });

    } catch (error: any) {
      logger.error('Error processing market data', error);
    }
  }

  /**
   * Handle WebSocket errors
   */
  private handleError(error: Error): void {
    logger.error('WebSocket error', error);
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
        logger.error('Cannot subscribe - token not found', { symbol });
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
        const subscribeMessage = {
          a: 'subscribe',
          v: [[mode === 'LTP' ? 1 : mode === 'QUOTE' ? 2 : 3, token]]
        };

        this.send(subscribeMessage);

        logger.info('📡 Subscribed to symbol', { symbol, token, mode });
      }

      return true;

    } catch (error: any) {
      logger.error('Error subscribing to symbol', { symbol, error: error.message });
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
      return;
    }

    logger.info('🔄 Resubscribing to all symbols', {
      count: this.subscriptions.size
    });

    const subscriptionList: any[] = [];

    for (const sub of this.subscriptions.values()) {
      const modeNum = sub.mode === 'LTP' ? 1 : sub.mode === 'QUOTE' ? 2 : 3;
      subscriptionList.push([modeNum, sub.token]);
    }

    const subscribeMessage = {
      a: 'subscribe',
      v: subscriptionList
    };

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
      logger.error('Max reconnection attempts reached');
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
