import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { AngelOneClient } from '../brokers/angelone/client';
import { MarketData } from '../types';
import { logger } from '../utils/logger';

interface WebSocketMessage {
  action: number;
  params: {
    mode: number;
    tokenList: Array<{
      exchangeType: number;
      tokens: string[];
    }>;
  };
}

interface TickData {
  exchange_type: number;
  token: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export class MarketDataService extends EventEmitter {
  private ws: WebSocket | null = null;
  private client: AngelOneClient;
  private subscribedSymbols: Map<string, string> = new Map(); // symbol -> token
  private symbolTokenToName: Map<string, string> = new Map(); // token -> symbol
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000;
  private isConnected: boolean = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private wsUrl: string = 'wss://smartapisocket.angelone.in/smart-stream';

  constructor(client: AngelOneClient) {
    super();
    this.client = client;
  }

  public async connect(): Promise<boolean> {
    try {
      const feedToken = this.client.getFeedToken();
      const clientCode = this.client['config'].clientId;

      if (!feedToken) {
        logger.error('Feed token not available');
        return false;
      }

      return new Promise((resolve, reject) => {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
          logger.info('WebSocket connected to Angel One');

          // Send authentication message
          const authMessage = {
            action: 1,
            params: {
              mode: 3,
              tokenList: []
            }
          };

          this.send(authMessage);

          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.startHeartbeat();

          logger.audit('WEBSOCKET_CONNECTED', { url: this.wsUrl });
          this.emit('connected');
          resolve(true);
        });

        this.ws.on('message', (data: Buffer) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (error: Error) => {
          logger.error('WebSocket error', error);
          this.emit('error', error);
          reject(error);
        });

        this.ws.on('close', (code: number, reason: string) => {
          logger.warn('WebSocket closed', { code, reason: reason.toString() });
          this.isConnected = false;
          this.stopHeartbeat();
          this.emit('disconnected');

          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
          } else {
            logger.error('Max reconnection attempts reached');
            this.emit('max_reconnect_attempts');
          }
        });

        this.ws.on('ping', () => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.pong();
          }
        });
      });
    } catch (error: any) {
      logger.error('Failed to connect WebSocket', error);
      return false;
    }
  }

  private handleMessage(data: Buffer): void {
    try {
      // Angel One sends binary data, need to parse it
      // This is a simplified parser - actual implementation depends on Angel One's protocol
      const jsonString = data.toString('utf8');

      try {
        const message = JSON.parse(jsonString);

        if (message.type === 'tick') {
          this.processTick(message.data);
        } else if (message.type === 'error') {
          logger.error('WebSocket message error', message);
        } else {
          logger.debug('WebSocket message received', message);
        }
      } catch (parseError) {
        // If not JSON, might be binary tick data
        this.parseBinaryTick(data);
      }
    } catch (error: any) {
      logger.error('Error handling WebSocket message', error);
    }
  }

  private parseBinaryTick(data: Buffer): void {
    try {
      // Binary format parsing for Angel One feed
      // This is placeholder - actual format needs to be implemented based on Angel One docs
      if (data.length < 8) return;

      const token = data.readUInt32BE(0).toString();
      const ltp = data.readDoubleBE(4);

      const symbol = this.symbolTokenToName.get(token);
      if (symbol) {
        const marketData: MarketData = {
          symbol: symbol,
          ltp: ltp,
          open: ltp, // These would be parsed from actual binary data
          high: ltp,
          low: ltp,
          close: ltp,
          volume: 0,
          timestamp: new Date()
        };

        this.emit('tick', marketData);
      }
    } catch (error: any) {
      logger.error('Error parsing binary tick', error);
    }
  }

  private processTick(tickData: TickData | TickData[]): void {
    const ticks = Array.isArray(tickData) ? tickData : [tickData];

    for (const tick of ticks) {
      const symbol = this.symbolTokenToName.get(tick.token);
      if (symbol) {
        const marketData: MarketData = {
          symbol: symbol,
          ltp: tick.ltp,
          open: tick.open,
          high: tick.high,
          low: tick.low,
          close: tick.close,
          volume: tick.volume,
          timestamp: new Date(tick.timestamp)
        };

        this.emit('tick', marketData);
        this.emit(`tick:${symbol}`, marketData);

        logger.debug('Market tick received', {
          symbol,
          ltp: tick.ltp,
          volume: tick.volume
        });
      }
    }
  }

  public subscribe(symbols: Map<string, string>): void {
    if (!this.isConnected || !this.ws) {
      logger.error('WebSocket not connected, cannot subscribe');
      return;
    }

    const tokenList: string[] = [];

    for (const [symbol, token] of symbols.entries()) {
      this.subscribedSymbols.set(symbol, token);
      this.symbolTokenToName.set(token, symbol);
      tokenList.push(token);
    }

    const subscribeMessage: WebSocketMessage = {
      action: 1, // Subscribe action
      params: {
        mode: 3, // Full mode (LTP, OHLC, Volume)
        tokenList: [
          {
            exchangeType: 1, // NSE
            tokens: tokenList
          }
        ]
      }
    };

    this.send(subscribeMessage);

    logger.info('Subscribed to symbols', {
      symbols: Array.from(symbols.keys()),
      count: tokenList.length
    });

    logger.audit('MARKET_DATA_SUBSCRIBED', {
      symbols: Array.from(symbols.keys())
    });
  }

  public unsubscribe(symbols: Map<string, string>): void {
    if (!this.isConnected || !this.ws) {
      logger.error('WebSocket not connected, cannot unsubscribe');
      return;
    }

    const tokenList: string[] = [];

    for (const [symbol, token] of symbols.entries()) {
      this.subscribedSymbols.delete(symbol);
      this.symbolTokenToName.delete(token);
      tokenList.push(token);
    }

    const unsubscribeMessage: WebSocketMessage = {
      action: 0, // Unsubscribe action
      params: {
        mode: 3,
        tokenList: [
          {
            exchangeType: 1, // NSE
            tokens: tokenList
          }
        ]
      }
    };

    this.send(unsubscribeMessage);

    logger.info('Unsubscribed from symbols', {
      symbols: Array.from(symbols.keys())
    });
  }

  private send(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error: any) {
        logger.error('Error sending WebSocket message', error);
      }
    } else {
      logger.warn('WebSocket not open, cannot send message');
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        logger.debug('Heartbeat ping sent');
      }
    }, 30000); // 30 seconds
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;

    logger.info(`Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    setTimeout(async () => {
      logger.info('Attempting to reconnect WebSocket');
      const connected = await this.connect();

      if (connected && this.subscribedSymbols.size > 0) {
        // Resubscribe to all symbols
        this.subscribe(this.subscribedSymbols);
      }
    }, delay);
  }

  public disconnect(): void {
    if (this.ws) {
      this.stopHeartbeat();
      this.isConnected = false;
      this.ws.close();
      this.ws = null;

      logger.info('WebSocket disconnected');
      logger.audit('WEBSOCKET_DISCONNECTED', {});
    }
  }

  public isWebSocketConnected(): boolean {
    return this.isConnected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public getSubscribedSymbols(): string[] {
    return Array.from(this.subscribedSymbols.keys());
  }
}
