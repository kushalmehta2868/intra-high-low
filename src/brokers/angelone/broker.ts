import { BaseBroker } from '../base';
import { AngelOneClient } from './client';
import { Order, Position, OrderSide, OrderType, OrderStatus, PositionType, Trade } from '../../types';
import { BrokerConfig } from '../../types';
import { logger } from '../../utils/logger';

export class AngelOneBroker extends BaseBroker {
  private client: AngelOneClient;
  private symbolTokenMap: Map<string, string> = new Map();

  constructor(config: BrokerConfig) {
    super();
    this.client = new AngelOneClient(config);
    this.initializeSymbolTokens();
  }

  private initializeSymbolTokens(): void {
    this.symbolTokenMap.set('RELIANCE-EQ', '2885');
    this.symbolTokenMap.set('TCS-EQ', '11536');
    this.symbolTokenMap.set('INFY-EQ', '1594');
    this.symbolTokenMap.set('HDFCBANK-EQ', '1333');
    this.symbolTokenMap.set('ICICIBANK-EQ', '4963');
    this.symbolTokenMap.set('TRENT-EQ', '1964');
    this.symbolTokenMap.set('ULTRACEMCO-EQ', '11532');
    this.symbolTokenMap.set('MUTHOOTFIN-EQ', '23650');
    this.symbolTokenMap.set('COFORGE-EQ', '11543');
    this.symbolTokenMap.set('ABB-EQ', '13');
    this.symbolTokenMap.set('ALKEM-EQ', '11703');
    this.symbolTokenMap.set('AMBER-EQ', '1185');
    this.symbolTokenMap.set('ANGELONE-EQ', '324');
    this.symbolTokenMap.set('APOLLOHOSP-EQ', '157');
    this.symbolTokenMap.set('BAJAJ-AUTO-EQ', '16669');
    this.symbolTokenMap.set('BHARTIARTL-EQ', '10604');
    this.symbolTokenMap.set('BRITANNIA-EQ', '547');
    this.symbolTokenMap.set('BSE-EQ', '19585');
    this.symbolTokenMap.set('CUMMINSIND-EQ', '1901');
    this.symbolTokenMap.set('DIXON-EQ', '21690');
    this.symbolTokenMap.set('GRASIM-EQ', '1232');
    this.symbolTokenMap.set('HAL-EQ', '2303');
    this.symbolTokenMap.set('HDFCAMC-EQ', '4244');
    this.symbolTokenMap.set('HEROMOTOCO-EQ', '1348');
  }

  private getSymbolToken(symbol: string): string {
    return this.symbolTokenMap.get(symbol) || '';
  }

  public async connect(): Promise<boolean> {
    try {
      const success = await this.client.login();
      this.isConnected = success;

      if (success) {
        logger.info('Angel One broker connected successfully');
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
    logger.info('Disconnected from Angel One broker');
  }

  public async placeOrder(
    symbol: string,
    side: OrderSide,
    type: OrderType,
    quantity: number,
    price?: number,
    stopPrice?: number
  ): Promise<Order | null> {
    if (!this.isConnected) {
      logger.error('Broker not connected');
      return null;
    }

    try {
      const symbolToken = this.getSymbolToken(symbol);
      if (!symbolToken) {
        logger.error('Symbol token not found', { symbol });
        return null;
      }

      const orderRequest = {
        variety: 'NORMAL',
        tradingsymbol: symbol,
        symboltoken: symbolToken,
        transactiontype: side,
        exchange: 'NSE',
        ordertype: this.mapOrderType(type),
        producttype: 'INTRADAY' as const,
        duration: 'DAY' as const,
        price: price ? price.toFixed(2) : '0',
        squareoff: '0',
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

    return {
      symbol: angelPos.tradingsymbol,
      type: quantity > 0 ? PositionType.LONG : PositionType.SHORT,
      quantity: Math.abs(quantity),
      entryPrice: avgPrice,
      currentPrice: ltp,
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

    try {
      const symbolToken = this.getSymbolToken(symbol);
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

  public addSymbolToken(symbol: string, token: string): void {
    this.symbolTokenMap.set(symbol, token);
  }
}
