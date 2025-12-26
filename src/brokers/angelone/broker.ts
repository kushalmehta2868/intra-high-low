import { BaseBroker } from '../base';
import { AngelOneClient } from './client';
import { Order, Position, OrderSide, OrderType, OrderStatus, PositionType, Trade, MarketData } from '../../types';
import { BrokerConfig } from '../../types';
import { logger } from '../../utils/logger';
import { symbolTokenService } from '../../services/symbolTokenService';
import { WebSocketDataFeed } from '../../services/websocketDataFeed';
import { marketDataCache } from '../../services/marketDataCache';
import { configManager } from '../../config';

interface PositionMetadata {
  stopLoss?: number;
  target?: number;
}

export class AngelOneBroker extends BaseBroker {
  private client: AngelOneClient;
  private positionMetadata: Map<string, PositionMetadata> = new Map();
  private wsDataFeed: WebSocketDataFeed | null = null;
  private watchlist: string[] = [];

  constructor(config: BrokerConfig, watchlist?: string[]) {
    super();
    this.client = new AngelOneClient(config);
    this.watchlist = watchlist || [];
  }

  /**
   * Get symbol token dynamically from token service
   */
  private async getSymbolToken(symbol: string): Promise<string | null> {
    return await symbolTokenService.getToken(symbol);
  }

  public async connect(): Promise<boolean> {
    try {
      const success = await this.client.login();
      this.isConnected = success;

      if (success) {
        logger.info('Angel One broker connected successfully');

        // Refresh symbol token cache on connect
        await symbolTokenService.refreshCache();
        logger.info('Symbol token cache refreshed');

        // Initialize WebSocket data feed for REAL mode
        if (this.watchlist.length > 0) {
          this.wsDataFeed = new WebSocketDataFeed(this.client);

          // Forward market data events from WebSocket to broker listeners AND cache
          this.wsDataFeed.on('market_data', (data: MarketData) => {
            // Update cache for instant access (eliminates API calls)
            marketDataCache.update(data);

            // Forward to strategies
            this.emitMarketData(data);
          });

          // Connect to WebSocket
          const wsConnected = await this.wsDataFeed.connect();
          if (wsConnected) {
            logger.info('✅ WebSocket connected for REAL mode');

            // Subscribe to all watchlist symbols
            await this.wsDataFeed.subscribeMultiple(this.watchlist, 'SNAP_QUOTE');
            logger.info('✅ Subscribed to symbols via WebSocket', {
              count: this.watchlist.length
            });
          } else {
            logger.warn('WebSocket connection failed - market data unavailable');
          }
        } else {
          logger.warn('⚠️ No watchlist provided - market data streaming disabled in REAL mode');
        }
      } else {
        logger.error('Failed to connect to Angel One broker');
      }

      return success;
    } catch (error: any) {
      logger.error('Connection error', error);
      this.emitError(error);
      return false;
    }
  }

  public async disconnect(): Promise<void> {
    this.isConnected = false;

    // Disconnect WebSocket data feed
    if (this.wsDataFeed) {
      this.wsDataFeed.disconnect();
      this.wsDataFeed = null;
      logger.info('WebSocket data feed disconnected');
    }

    // Clear position metadata on disconnect
    this.positionMetadata.clear();
    logger.info('Disconnected from Angel One broker - position metadata cleared');
  }

  public async placeOrder(
    symbol: string,
    side: OrderSide,
    type: OrderType,
    quantity: number,
    price?: number,
    stopPrice?: number,
    target?: number
  ): Promise<Order | null> {
    if (!this.isConnected) {
      logger.error('Broker not connected');
      return null;
    }

    try {
      const symbolToken = await this.getSymbolToken(symbol);
      if (!symbolToken) {
        logger.error('Symbol token not found', { symbol });
        return null;
      }

      // For bracket orders, Angel One requires variety='ROBO' and absolute trigger prices
      // squareoff = target price (absolute)
      // stoploss = stop-loss trigger price (absolute)
      const useROBOOrder = (stopPrice || target) && type === OrderType.MARKET;

      const orderRequest = {
        variety: useROBOOrder ? 'ROBO' : 'NORMAL',
        tradingsymbol: symbol,
        symboltoken: symbolToken,
        transactiontype: side,
        exchange: 'NSE',
        ordertype: this.mapOrderType(type),
        producttype: 'INTRADAY' as const,
        duration: 'DAY' as const,
        price: price ? price.toFixed(2) : '0',
        squareoff: target ? target.toFixed(2) : '0',
        stoploss: stopPrice ? stopPrice.toFixed(2) : '0',
        quantity: quantity.toString()
      };

      const orderId = await this.client.placeOrder(orderRequest);

      if (orderId) {
        const order: Order = {
          orderId: orderId,
          symbol: symbol,
          side: side,
          type: type,
          quantity: quantity,
          price: price,
          stopPrice: stopPrice,
          status: OrderStatus.SUBMITTED,
          filledQuantity: 0,
          averagePrice: 0,
          timestamp: new Date(),
          broker: 'AngelOne'
        };

        // Store stopLoss and target metadata for this symbol
        if (stopPrice || target) {
          this.positionMetadata.set(symbol, {
            stopLoss: stopPrice,
            target: target
          });

          if (useROBOOrder) {
            logger.info('✅ BRACKET Order placed with built-in exits', {
              orderId,
              symbol,
              orderType: 'ROBO (Bracket)',
              stopLoss: stopPrice ? `₹${stopPrice.toFixed(2)}` : 'N/A',
              target: target ? `₹${target.toFixed(2)}` : 'N/A',
              note: 'Stop-loss and target will execute automatically'
            });
          } else {
            logger.info('Order placed with exit levels (manual monitoring)', {
              orderId,
              symbol,
              stopLoss: stopPrice ? `₹${stopPrice.toFixed(2)}` : 'N/A',
              target: target ? `₹${target.toFixed(2)}` : 'N/A'
            });
          }
        }

        this.emitOrderUpdate(order);
        return order;
      }

      return null;
    } catch (error: any) {
      logger.error('Place order error', error);
      this.emitError(error);
      return null;
    }
  }

  private mapOrderType(type: OrderType): 'MARKET' | 'LIMIT' | 'STOPLOSS_LIMIT' | 'STOPLOSS_MARKET' {
    switch (type) {
      case OrderType.MARKET:
        return 'MARKET';
      case OrderType.LIMIT:
        return 'LIMIT';
      case OrderType.STOP_LOSS:
        return 'STOPLOSS_LIMIT';
      case OrderType.STOP_LOSS_MARKET:
        return 'STOPLOSS_MARKET';
      default:
        return 'MARKET';
    }
  }

  public async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.isConnected) {
      logger.error('Broker not connected');
      return false;
    }

    return await this.client.cancelOrder(orderId);
  }

  public async getOrders(): Promise<Order[]> {
    if (!this.isConnected) {
      logger.error('Broker not connected');
      return [];
    }

    try {
      const orderBook = await this.client.getOrderBook();
      return orderBook.map((order: any) => this.mapAngelOrderToOrder(order));
    } catch (error: any) {
      logger.error('Get orders error', error);
      return [];
    }
  }

  private mapAngelOrderToOrder(angelOrder: any): Order {
    return {
      orderId: angelOrder.orderid,
      symbol: angelOrder.tradingsymbol,
      side: angelOrder.transactiontype as OrderSide,
      type: this.mapAngelOrderType(angelOrder.ordertype),
      quantity: parseInt(angelOrder.quantity),
      price: parseFloat(angelOrder.price || '0'),
      stopPrice: parseFloat(angelOrder.triggerprice || '0'),
      status: this.mapAngelOrderStatus(angelOrder.orderstatus),
      filledQuantity: parseInt(angelOrder.filledshares || '0'),
      averagePrice: parseFloat(angelOrder.averageprice || '0'),
      timestamp: new Date(angelOrder.ordertime),
      broker: 'AngelOne'
    };
  }

  private mapAngelOrderType(type: string): OrderType {
    switch (type) {
      case 'MARKET': return OrderType.MARKET;
      case 'LIMIT': return OrderType.LIMIT;
      case 'STOPLOSS_LIMIT': return OrderType.STOP_LOSS;
      case 'STOPLOSS_MARKET': return OrderType.STOP_LOSS_MARKET;
      default: return OrderType.MARKET;
    }
  }

  private mapAngelOrderStatus(status: string): OrderStatus {
    switch (status.toUpperCase()) {
      case 'PENDING': return OrderStatus.PENDING;
      case 'OPEN': return OrderStatus.SUBMITTED;
      case 'COMPLETE': return OrderStatus.FILLED;
      case 'REJECTED': return OrderStatus.REJECTED;
      case 'CANCELLED': return OrderStatus.CANCELLED;
      default: return OrderStatus.PENDING;
    }
  }

  public async getPositions(): Promise<Position[]> {
    if (!this.isConnected) {
      logger.error('Broker not connected');
      return [];
    }

    try {
      const positions = await this.client.getPositions();
      return positions
        .filter((pos: any) => parseInt(pos.netqty) !== 0)
        .map((pos: any) => this.mapAngelPositionToPosition(pos));
    } catch (error: any) {
      logger.error('Get positions error', error);
      return [];
    }
  }

  private mapAngelPositionToPosition(angelPos: any): Position {
    const quantity = parseInt(angelPos.netqty);
    const avgPrice = parseFloat(angelPos.netprice || angelPos.avgprice || '0');
    const ltp = parseFloat(angelPos.ltp || '0');
    const pnl = parseFloat(angelPos.pnl || '0');
    const symbol = angelPos.tradingsymbol;

    // Get stored metadata for this position
    const metadata = this.positionMetadata.get(symbol);

    return {
      symbol: symbol,
      type: quantity > 0 ? PositionType.LONG : PositionType.SHORT,
      quantity: Math.abs(quantity),
      entryPrice: avgPrice,
      currentPrice: ltp,
      stopLoss: metadata?.stopLoss,
      target: metadata?.target,
      pnl: pnl,
      pnlPercent: avgPrice !== 0 ? (pnl / (avgPrice * Math.abs(quantity))) * 100 : 0,
      entryTime: new Date()
    };
  }

  public async getAccountBalance(): Promise<number> {
    if (!this.isConnected) {
      logger.error('Broker not connected');
      return 0;
    }

    try {
      const rmsData = await this.client.getRMS();
      return parseFloat(rmsData?.net || '0');
    } catch (error: any) {
      logger.error('Get account balance error', error);
      return 0;
    }
  }

  public async getLTP(symbol: string): Promise<number | null> {
    if (!this.isConnected) {
      logger.error('Broker not connected');
      return null;
    }

    // OPTIMIZATION: Try cache first (WebSocket data) - eliminates API call
    const cachedLTP = marketDataCache.getLTP(symbol);
    if (cachedLTP !== null) {
      logger.debug('LTP from cache (WebSocket)', {
        symbol,
        ltp: `₹${cachedLTP.toFixed(2)}`,
        source: 'WebSocket Cache'
      });
      return cachedLTP;
    }

    // Fallback: Use API only if cache miss (no WebSocket data yet)
    logger.debug('Cache miss - fetching LTP from API', { symbol });

    try {
      const symbolToken = await this.getSymbolToken(symbol);
      if (!symbolToken) {
        logger.error('Symbol token not found', { symbol });
        return null;
      }

      return await this.client.getLTP('NSE', symbol, symbolToken);
    } catch (error: any) {
      logger.error('Get LTP error', error);
      return null;
    }
  }

  /**
   * @deprecated Tokens are now fetched dynamically. This method is kept for backwards compatibility.
   */
  public addSymbolToken(symbol: string, token: string): void {
    logger.warn('addSymbolToken is deprecated - tokens are now fetched dynamically');
  }
}
