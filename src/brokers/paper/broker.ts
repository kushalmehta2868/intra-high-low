import { BaseBroker } from '../base';
import { Order, Position, OrderSide, OrderType, OrderStatus, PositionType, Trade, BrokerConfig, MarketData } from '../../types';
import { logger } from '../../utils/logger';
import { AngelOneClient } from '../angelone/client';
import { TradingTelegramBot } from '../../telegram/bot';
import { TelegramConfig } from '../../types';
import { WebSocketDataFeed } from '../../services/websocketDataFeed';
import { symbolTokenService } from '../../services/symbolTokenService';
import { configManager } from '../../config';

interface SimulatedOrder extends Order {
  submittedAt: Date;
  target?: number;
}

/**
 * Paper Trading Broker - Uses REAL Angel One market data but sends signals to Telegram
 * instead of placing actual orders. Perfect for testing strategies with live data.
 */
export class PaperBroker extends BaseBroker {
  private orders: Map<string, SimulatedOrder> = new Map();
  private positions: Map<string, Position> = new Map();
  private accountBalance: number = 1000000;
  private startingBalance: number = 1000000;

  // Real Angel One client for market data
  private angelClient: AngelOneClient | null = null;
  private telegramBot: TradingTelegramBot | null = null;
  private wsDataFeed: WebSocketDataFeed | null = null;

  // Track monitoring intervals to prevent leaks and duplicate monitoring
  private monitoringIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    initialBalance: number = 1000000,
    angelConfig?: BrokerConfig,
    telegramConfig?: TelegramConfig,
    watchlist?: string[]
  ) {
    super();
    this.accountBalance = initialBalance;
    this.startingBalance = initialBalance;

    // Initialize real Angel One client for data fetching
    if (angelConfig) {
      this.angelClient = new AngelOneClient(angelConfig);
    }

    // Initialize Telegram bot for signal notifications
    if (telegramConfig) {
      this.telegramBot = new TradingTelegramBot(telegramConfig);
    }

    // Store watchlist for later use when creating MarketDataFetcher
    if (watchlist && watchlist.length > 0) {
      (this as any).watchlist = watchlist;
    }
  }

  public async connect(): Promise<boolean> {
    try {
      // Connect to real Angel One API for market data
      if (this.angelClient) {
        const connected = await this.angelClient.login();
        if (!connected) {
          logger.warn('Angel One connection failed - will use fallback prices');
        } else {
          logger.info('✅ Connected to Angel One for REAL market data');

          // Refresh symbol token cache
          await symbolTokenService.refreshCache();
          logger.info('✅ Symbol token cache refreshed');

          // Initialize WebSocket data feed for real-time market data
          this.wsDataFeed = new WebSocketDataFeed(this.angelClient);

          // Forward market data events
          this.wsDataFeed.on('market_data', (data: MarketData) => {
            // Emit market data for strategies to consume
            this.emit('market_data', data);
          });

          // Connect to WebSocket
          const wsConnected = await this.wsDataFeed.connect();
          if (wsConnected) {
            logger.info('✅ WebSocket market data connected');

            // Subscribe to all symbols in watchlist
            const watchlist = (this as any).watchlist;
            if (watchlist && watchlist.length > 0) {
              await this.wsDataFeed.subscribeMultiple(watchlist, 'SNAP_QUOTE');
              logger.info('✅ Subscribed to symbols via WebSocket', {
                count: watchlist.length
              });
            }
          } else {
            logger.warn('WebSocket connection failed - market data unavailable');
          }
        }
      }

      // Start Telegram bot
      if (this.telegramBot) {
        await this.telegramBot.start();
        await this.telegramBot.sendMessage(
          '📊 *Paper Trading Mode Started*\n\n' +
          '✅ Using REAL market data from Angel One\n' +
          '📱 Signals will be sent to this chat\n' +
          `💰 Starting Balance: ₹${this.startingBalance.toLocaleString('en-IN')}\n\n` +
          '⚠️ No actual orders will be placed\n\n' +
          '📡 Real-time WebSocket market data streaming'
        );
      }

      this.isConnected = true;
      logger.info('Paper broker connected (REAL data mode)');
      logger.audit('PAPER_BROKER_CONNECTED', {
        initialBalance: this.accountBalance,
        realDataEnabled: this.angelClient !== null,
        dataStreamingEnabled: this.wsDataFeed !== null
      });

      return true;
    } catch (error: any) {
      logger.error('Paper broker connection error', error);
      return false;
    }
  }

  public async disconnect(): Promise<void> {
    // Disconnect WebSocket data feed
    if (this.wsDataFeed) {
      this.wsDataFeed.disconnect();
      this.wsDataFeed = null;
    }

    this.isConnected = false;

    // Send final summary to Telegram
    if (this.telegramBot) {
      const stats = this.getAccountStats();
      await this.telegramBot.sendMessage(
        '🏁 *Paper Trading Session Ended*\n\n' +
        `💰 Starting Balance: ₹${this.startingBalance.toLocaleString('en-IN')}\n` +
        `💰 Final Balance: ₹${stats.currentBalance.toLocaleString('en-IN')}\n` +
        `${stats.totalPnL >= 0 ? '📈' : '📉'} Total P&L: ₹${stats.totalPnL.toLocaleString('en-IN')} (${stats.totalPnLPercent.toFixed(2)}%)\n` +
        `📊 Total Orders: ${this.orders.size}\n` +
        `📦 Open Positions: ${this.positions.size}`
      );
      await this.telegramBot.stop();
    }

    // Clear all data on disconnect
    this.orders.clear();
    this.positions.clear();

    // FIXED: Clean up all monitoring intervals to prevent memory leaks
    for (const [symbol, interval] of this.monitoringIntervals.entries()) {
      clearInterval(interval);
      logger.debug(`Cleaned up monitoring interval for ${symbol}`);
    }
    this.monitoringIntervals.clear();

    logger.info('Disconnected from paper broker - all positions, orders, and monitoring cleared');
    logger.audit('PAPER_BROKER_DISCONNECTED', {
      finalBalance: this.accountBalance,
      pnl: this.accountBalance - this.startingBalance
    });
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
      logger.error('Paper broker not connected');
      return null;
    }

    try {
      const orderId = this.generateOrderId();

      // Get REAL current price from Angel One
      const currentPrice = await this.getRealLTP(symbol) || price || 100;

      const order: SimulatedOrder = {
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
        submittedAt: new Date(),
        broker: 'Paper',
        target: target
      };

      this.orders.set(orderId, order);
      this.emitOrderUpdate(order);

      // Send SIGNAL to Telegram instead of placing real order
      await this.sendTelegramSignal(order, currentPrice);

      logger.info('Paper order signal sent', {
        orderId,
        symbol,
        side,
        type,
        quantity,
        price: currentPrice
      });

      logger.audit('PAPER_ORDER_SIGNAL', order);

      // Simulate order execution for paper trading P&L tracking
      setTimeout(() => {
        this.simulateOrderExecution(orderId, currentPrice);
      }, Math.random() * 1000 + 500);

      return order;
    } catch (error: any) {
      logger.error('Paper place order error', error);
      this.emitError(error);
      return null;
    }
  }

  /**
   * Send trading signal to Telegram
   */
  private async sendTelegramSignal(order: SimulatedOrder, currentPrice: number): Promise<void> {
    if (!this.telegramBot) return;

    const action = order.side === OrderSide.BUY ? '🟢 BUY' : '🔴 SELL';
    const emoji = order.side === OrderSide.BUY ? '📈' : '📉';

    let message = `${emoji} *TRADING SIGNAL*\n\n`;
    message += `${action} ${order.symbol}\n\n`;
    message += `📊 *Order Details:*\n`;
    message += `• Type: ${order.type}\n`;
    message += `• Quantity: ${order.quantity}\n`;
    message += `• Current Price: ₹${currentPrice.toFixed(2)}\n`;

    if (order.stopPrice) {
      message += `• Stop Loss: ₹${order.stopPrice.toFixed(2)}\n`;
    }

    if (order.target) {
      message += `• Target: ₹${order.target.toFixed(2)}\n`;
    }

    if (order.price && order.type === OrderType.LIMIT) {
      message += `• Limit Price: ₹${order.price.toFixed(2)}\n`;
    }

    // Calculate potential risk/reward
    if (order.stopPrice) {
      const riskPerShare = Math.abs(currentPrice - order.stopPrice);
      const totalRisk = riskPerShare * order.quantity;
      const riskPercent = (riskPerShare / currentPrice) * 100;

      message += `\n💰 *Risk Analysis:*\n`;
      message += `• Risk per share: ₹${riskPerShare.toFixed(2)}\n`;
      message += `• Total Risk: ₹${totalRisk.toFixed(2)}\n`;
      message += `• Risk %: ${riskPercent.toFixed(2)}%\n`;
    }

    // Add account info
    message += `\n💼 *Account:*\n`;
    message += `• Balance: ₹${this.accountBalance.toLocaleString('en-IN')}\n`;
    message += `• Open Positions: ${this.positions.size}\n`;

    message += `\n⏰ Time: ${new Date().toLocaleTimeString('en-IN')}\n`;
    message += `🆔 Order ID: ${order.orderId}\n`;

    message += `\n⚠️ *This is a PAPER TRADING signal*\n`;
    message += `📝 No actual order will be placed`;

    await this.telegramBot.sendMessage(message);
  }

  /**
   * Get real LTP from Angel One
   */
  private async getRealLTP(symbol: string): Promise<number | null> {
    if (!this.angelClient || !this.angelClient.isAuthenticated()) {
      return null;
    }

    try {
      const symbolToken = await symbolTokenService.getToken(symbol);
      if (!symbolToken) {
        logger.warn('Symbol token not found', { symbol });
        return null;
      }

      const ltp = await this.angelClient.getLTP('NSE', symbol, symbolToken);
      return ltp;
    } catch (error: any) {
      logger.error('Failed to get real LTP', { symbol, error: error.message });
      return null;
    }
  }

  private generateOrderId(): string {
    return `PAPER-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Set up bracket order monitoring - simulates automatic exit on stop-loss or target hit
   */
  private setupBracketOrderMonitoring(symbol: string, position: Position): void {
    // FIXED: Clear any existing monitoring interval for this symbol to prevent duplicate monitoring
    const existingInterval = this.monitoringIntervals.get(symbol);
    if (existingInterval) {
      clearInterval(existingInterval);
      logger.warn(`Clearing existing monitoring interval for ${symbol} (duplicate avoided)`);
    }

    // Check every second for exit conditions (simulating exchange-level monitoring)
    const monitoringInterval = setInterval(async () => {
      const currentPosition = this.positions.get(symbol);

      // Stop monitoring if position is closed
      if (!currentPosition || currentPosition.quantity === 0) {
        clearInterval(monitoringInterval);
        this.monitoringIntervals.delete(symbol);
        logger.debug(`Monitoring stopped for ${symbol} - position closed`);
        return;
      }

      // Get current price
      const currentPrice = await this.getRealLTP(symbol);
      if (!currentPrice) return;

      // Update position price
      currentPosition.currentPrice = currentPrice;

      // Check stop-loss hit
      if (position.stopLoss) {
        const stopLossHit = position.type === PositionType.LONG
          ? currentPrice <= position.stopLoss
          : currentPrice >= position.stopLoss;

        if (stopLossHit) {
          clearInterval(monitoringInterval);
          this.monitoringIntervals.delete(symbol);
          logger.info('🛑 BRACKET ORDER: Stop-loss triggered automatically', {
            symbol,
            type: 'STOP_LOSS',
            triggerPrice: `₹${position.stopLoss.toFixed(2)}`,
            currentPrice: `₹${currentPrice.toFixed(2)}`,
            note: 'Simulating exchange-level auto-exit'
          });
          await this.executeAutomaticExit(symbol, currentPosition, currentPrice, 'STOP_LOSS');
          return;
        }
      }

      // Check target hit
      if (position.target) {
        const targetHit = position.type === PositionType.LONG
          ? currentPrice >= position.target
          : currentPrice <= position.target;

        if (targetHit) {
          clearInterval(monitoringInterval);
          this.monitoringIntervals.delete(symbol);
          logger.info('🎯 BRACKET ORDER: Target reached automatically', {
            symbol,
            type: 'TARGET',
            triggerPrice: `₹${position.target.toFixed(2)}`,
            currentPrice: `₹${currentPrice.toFixed(2)}`,
            note: 'Simulating exchange-level auto-exit'
          });
          await this.executeAutomaticExit(symbol, currentPosition, currentPrice, 'TARGET');
          return;
        }
      }
    }, 1000); // Check every second

    // FIXED: Track this interval for cleanup
    this.monitoringIntervals.set(symbol, monitoringInterval);

    logger.info('✅ BRACKET ORDER monitoring activated', {
      symbol,
      stopLoss: position.stopLoss ? `₹${position.stopLoss.toFixed(2)}` : 'N/A',
      target: position.target ? `₹${position.target.toFixed(2)}` : 'N/A',
      note: 'Will auto-exit when stop-loss or target is hit'
    });
  }

  /**
   * Execute automatic exit for bracket order
   */
  private async executeAutomaticExit(
    symbol: string,
    position: Position,
    exitPrice: number,
    exitReason: 'STOP_LOSS' | 'TARGET'
  ): Promise<void> {
    // Create exit order
    const exitSide = position.type === PositionType.LONG ? OrderSide.SELL : OrderSide.BUY;
    const orderId = this.generateOrderId();

    const exitOrder: SimulatedOrder = {
      orderId,
      symbol,
      side: exitSide,
      type: OrderType.MARKET,
      quantity: position.quantity,
      price: undefined,
      stopPrice: undefined,
      status: OrderStatus.FILLED,
      filledQuantity: position.quantity,
      averagePrice: exitPrice,
      timestamp: new Date(),
      submittedAt: new Date(),
      broker: 'Paper',
      target: undefined
    };

    // Calculate P&L
    const pnl = position.type === PositionType.LONG
      ? (exitPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - exitPrice) * position.quantity;

    // Update account balance
    this.accountBalance += pnl;

    // Create closed position event for PositionManager
    const closedPosition: Position = {
      ...position,
      quantity: 0,
      currentPrice: exitPrice,
      pnl: pnl,
      pnlPercent: (pnl / (position.entryPrice * position.quantity)) * 100
    };

    // Remove position
    this.positions.delete(symbol);

    // Emit position_update so PositionManager can track closure
    this.emitPositionUpdate(closedPosition);

    // Send Telegram notification
    if (this.telegramBot) {
      const emoji = exitReason === 'TARGET' ? '🎯' : '🛑';
      const action = exitSide === OrderSide.SELL ? 'SELL' : 'BUY';
      const pnlPercent = ((pnl / (position.entryPrice * position.quantity)) * 100);
      const pnlEmoji = pnl >= 0 ? '✅' : '❌';
      const now = new Date();
      const timeStr = now.toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      let message = `${emoji} *BRACKET ORDER AUTO-EXIT*\n\n`;
      message += `🕐 *Time:* ${timeStr}\n`;
      message += `*Action:* ${action}\n`;
      message += `*Symbol:* \`${symbol}\`\n`;
      message += `*Reason:* ${exitReason === 'TARGET' ? '🎯 Target Reached' : '🛑 Stop-Loss Hit'}\n\n`;
      message += `*Entry Price:* ₹${position.entryPrice.toFixed(2)}\n`;
      message += `*Exit Price:* ₹${exitPrice.toFixed(2)}\n`;
      message += `*Quantity:* ${position.quantity}\n`;
      message += `*Order Value:* ₹${(exitPrice * position.quantity).toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n\n`;
      message += `${pnlEmoji} *P&L:* ₹${pnl.toLocaleString('en-IN', { maximumFractionDigits: 2 })} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n\n`;

      // Add current balance and open positions
      message += `───────────────────\n`;
      message += `*Account Balance:* ₹${this.accountBalance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n`;
      message += `*Open Positions:* ${this.positions.size}\n\n`;
      message += `⚡ *Executed automatically by bracket order*`;

      await this.telegramBot.sendMessage(message);
    }

    logger.info('✅ Bracket order exit completed', {
      symbol,
      exitReason,
      entryPrice: `₹${position.entryPrice.toFixed(2)}`,
      exitPrice: `₹${exitPrice.toFixed(2)}`,
      quantity: position.quantity,
      pnl: `₹${pnl.toFixed(2)}`,
      pnlPercent: `${((pnl / (position.entryPrice * position.quantity)) * 100).toFixed(2)}%`
    });

    logger.audit('BRACKET_ORDER_EXIT', {
      symbol,
      exitReason,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      pnl
    });
  }

  private simulateOrderExecution(orderId: string, executionPrice: number): void {
    const order = this.orders.get(orderId);
    if (!order) return;

    if (order.type === OrderType.MARKET || order.type === OrderType.LIMIT) {
      const fillPrice = order.type === OrderType.LIMIT && order.price
        ? order.price
        : executionPrice;

      order.status = OrderStatus.FILLED;
      order.filledQuantity = order.quantity;
      order.averagePrice = fillPrice;

      this.emitOrderUpdate(order);

      const trade: Trade = {
        tradeId: `TRADE-${orderId}`,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        price: fillPrice,
        timestamp: new Date(),
        orderId: orderId
      };

      this.emitTrade(trade);
      this.updatePosition(order, fillPrice);

      logger.info('Paper order filled', {
        orderId,
        symbol: order.symbol,
        price: fillPrice,
        quantity: order.quantity
      });

      logger.audit('PAPER_ORDER_FILLED', { order, trade });
    }
  }

  private updatePosition(order: SimulatedOrder, fillPrice: number): void {
    const existingPosition = this.positions.get(order.symbol);

    if (!existingPosition) {
      const newPosition: Position = {
        symbol: order.symbol,
        type: order.side === OrderSide.BUY ? PositionType.LONG : PositionType.SHORT,
        quantity: order.quantity,
        entryPrice: fillPrice,
        currentPrice: fillPrice,
        pnl: 0,
        pnlPercent: 0,
        entryTime: new Date(),
        stopLoss: order.stopPrice,
        target: order.target
      };

      this.positions.set(order.symbol, newPosition);
      this.emitPositionUpdate(newPosition);

      // Note: In paper trading, balance doesn't change when opening positions
      // Balance only changes when positions are closed based on P&L
      // This simulates real margin trading where you don't "spend" the full amount upfront

      // Simulate bracket order behavior - set up auto-exit monitoring
      if (order.stopPrice || order.target) {
        this.setupBracketOrderMonitoring(order.symbol, newPosition);
      }
    } else {
      if ((existingPosition.type === PositionType.LONG && order.side === OrderSide.SELL) ||
        (existingPosition.type === PositionType.SHORT && order.side === OrderSide.BUY)) {

        const closedQuantity = Math.min(existingPosition.quantity, order.quantity);
        const pnl = existingPosition.type === PositionType.LONG
          ? (fillPrice - existingPosition.entryPrice) * closedQuantity
          : (existingPosition.entryPrice - fillPrice) * closedQuantity;

        this.accountBalance += pnl;
        existingPosition.quantity -= closedQuantity;
        existingPosition.pnl += pnl;

        if (existingPosition.quantity === 0) {
          this.positions.delete(order.symbol);
        } else {
          this.emitPositionUpdate(existingPosition);
        }

        logger.info('Position closed/reduced', {
          symbol: order.symbol,
          closedQuantity,
          pnl,
          remainingQuantity: existingPosition.quantity
        });

        logger.audit('POSITION_CLOSED', {
          symbol: order.symbol,
          pnl,
          closedQuantity,
          fillPrice
        });
      } else {
        const totalQuantity = existingPosition.quantity + order.quantity;
        const avgPrice = ((existingPosition.entryPrice * existingPosition.quantity) +
          (fillPrice * order.quantity)) / totalQuantity;

        existingPosition.quantity = totalQuantity;
        existingPosition.entryPrice = avgPrice;
        this.emitPositionUpdate(existingPosition);
      }
    }
  }

  public async cancelOrder(orderId: string): Promise<boolean> {
    const order = this.orders.get(orderId);
    if (!order) {
      logger.warn('Order not found for cancellation', { orderId });
      return false;
    }

    if (order.status === OrderStatus.FILLED || order.status === OrderStatus.CANCELLED) {
      logger.warn('Cannot cancel order', { orderId, status: order.status });
      return false;
    }

    order.status = OrderStatus.CANCELLED;
    this.emitOrderUpdate(order);

    logger.info('Paper order cancelled', { orderId });
    logger.audit('PAPER_ORDER_CANCELLED', { orderId });

    return true;
  }

  public async getOrders(): Promise<Order[]> {
    return Array.from(this.orders.values());
  }

  public async getPositions(): Promise<Position[]> {
    const positions = Array.from(this.positions.values());

    for (const position of positions) {
      // Try to get real current price from Angel One
      const realPrice = await this.getRealLTP(position.symbol);
      const currentPrice = realPrice || position.currentPrice;

      position.currentPrice = currentPrice;

      if (position.type === PositionType.LONG) {
        position.pnl = (currentPrice - position.entryPrice) * position.quantity;
      } else {
        position.pnl = (position.entryPrice - currentPrice) * position.quantity;
      }

      position.pnlPercent = (position.pnl / (position.entryPrice * position.quantity)) * 100;
    }

    return positions;
  }

  public async getAccountBalance(): Promise<number> {
    return this.accountBalance;
  }

  /**
   * Get REAL LTP from Angel One (not simulated)
   */
  public async getLTP(symbol: string): Promise<number | null> {
    return await this.getRealLTP(symbol);
  }

  /**
   * Update market price - fetches real price if Angel client is available
   */
  public async updateMarketPrice(symbol: string, price?: number): Promise<void> {
    // Try to get real price first
    const realPrice = await this.getRealLTP(symbol);
    const finalPrice = realPrice || price;

    if (!finalPrice) return;

    const position = this.positions.get(symbol);
    if (position) {
      position.currentPrice = finalPrice;

      if (position.type === PositionType.LONG) {
        position.pnl = (finalPrice - position.entryPrice) * position.quantity;
      } else {
        position.pnl = (position.entryPrice - finalPrice) * position.quantity;
      }

      position.pnlPercent = (position.pnl / (position.entryPrice * position.quantity)) * 100;

      this.emitPositionUpdate(position);
    }
  }

  /**
   * @deprecated Tokens are now fetched dynamically. This method is kept for backwards compatibility.
   */
  public addSymbolToken(symbol: string, token: string): void {
    logger.warn('addSymbolToken is deprecated - tokens are now fetched dynamically');
  }

  public getAccountStats() {
    return {
      startingBalance: this.startingBalance,
      currentBalance: this.accountBalance,
      totalPnL: this.accountBalance - this.startingBalance,
      totalPnLPercent: ((this.accountBalance - this.startingBalance) / this.startingBalance) * 100
    };
  }
}
