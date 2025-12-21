# Integration Guide - How to Use All New Services

This guide shows you exactly how to integrate all the new services into your trading bot.

---

## Step 1: Update Trading Engine Imports

Add these imports to `src/core/tradingEngine.ts`:

```typescript
import { orderStateManager } from '../services/orderStateManager';
import { StopLossManager } from '../services/stopLossManager';
import { PerformanceTracker } from '../services/performanceTracker';
import { PositionReconciliationService } from '../services/positionReconciliation';
import { WebSocketDataFeed } from '../services/websocketDataFeed';
```

---

## Step 2: Add Service Properties to TradingEngine Class

```typescript
export class TradingEngine extends EventEmitter {
  // ... existing properties

  private stopLossManager: StopLossManager;
  private performanceTracker: PerformanceTracker;
  private reconciliationService: PositionReconciliationService;
  private websocketFeed?: WebSocketDataFeed;

  constructor(config: AppConfig) {
    super();
    this.config = config;

    this.broker = this.initializeBroker();
    this.initialBalance = 1000000;

    // Initialize new services
    this.stopLossManager = new StopLossManager(this.broker);
    this.performanceTracker = new PerformanceTracker(this.initialBalance);
    this.riskManager = new RiskManager(config.trading.riskLimits, this.initialBalance);
    this.positionManager = new PositionManager(this.broker);

    // Position reconciliation needs access to position map
    this.reconciliationService = new PositionReconciliationService(
      this.broker,
      this.positionManager.getAllPositions() // You may need to add getPositionsMap() method
    );

    this.scheduler = new MarketScheduler(
      config.trading.marketStartTime,
      config.trading.marketEndTime,
      config.trading.autoSquareOffTime
    );
    this.telegramBot = new TradingTelegramBot(config.telegram);

    this.setupEventHandlers();
    this.setupServiceEventHandlers(); // New method
  }
}
```

---

## Step 3: Setup Service Event Handlers

Add this new method to `TradingEngine`:

```typescript
private setupServiceEventHandlers(): void {
  // Stop Loss Manager Events
  this.stopLossManager.on('stop_loss_triggered', async (data) => {
    logger.error('🛑 STOP LOSS TRIGGERED AT BROKER', data);
    await this.telegramBot.sendAlert(
      'Stop Loss Hit',
      `Stop loss triggered for ${data.symbol} at ₹${data.stopLossPrice.toFixed(2)}`
    );
  });

  this.stopLossManager.on('target_hit', async (data) => {
    logger.info('🎯 TARGET HIT AT BROKER', data);
    await this.telegramBot.sendAlert(
      'Target Reached',
      `Target hit for ${data.symbol}!`
    );
  });

  // Position Reconciliation Events
  this.reconciliationService.on('mismatches_detected', async (mismatches) => {
    logger.error('⚠️  POSITION MISMATCHES DETECTED', { count: mismatches.length });
    await this.telegramBot.sendAlert(
      'Position Mismatch',
      `${mismatches.length} position mismatches detected. Check logs.`
    );
  });

  this.reconciliationService.on('position_orphaned', async (position) => {
    logger.error('❌ ORPHANED POSITION', position);
    await this.telegramBot.sendAlert(
      'Critical: Orphaned Position',
      `Position for ${position?.symbol} exists in bot but not at broker. Manual intervention required.`
    );
  });

  // Performance Tracker Events
  this.performanceTracker.on('trade_recorded', (trade) => {
    const metrics = this.performanceTracker.getMetrics();
    logger.info('📊 Trade recorded, updated metrics', {
      totalTrades: metrics.totalTrades,
      winRate: `${metrics.winRate.toFixed(2)}%`,
      netProfit: `₹${metrics.netProfit.toFixed(2)}`
    });
  });

  // Order State Manager Events
  orderStateManager.on('order_rejected', async (order) => {
    logger.error('❌ ORDER REJECTED', order);
    await this.telegramBot.sendAlert(
      'Order Rejected',
      `Order for ${order.symbol} rejected: ${order.errorMessage || 'Unknown reason'}`
    );
  });

  orderStateManager.on('order_timeout', async (order) => {
    logger.warn('⏰ ORDER TIMEOUT', order);
    await this.telegramBot.sendAlert(
      'Order Timeout',
      `No response from broker for ${order.symbol} order`
    );
  });
}
```

---

## Step 4: Update Order Placement Logic

Modify `handleStrategySignal` to use order state manager:

```typescript
private async handleStrategySignal(signal: StrategySignal): Promise<void> {
  // ... existing validation code

  const result = await positionLockManager.withLock(signal.symbol, async () => {
    try {
      if (signal.action === 'CLOSE') {
        await this.closePosition(signal.symbol, signal.reason);
        return;
      }

      const currentPrice = await this.broker.getLTP(signal.symbol);
      if (!currentPrice) {
        logger.error('Failed to get current price', { symbol: signal.symbol });
        return;
      }

      const stopLoss = signal.stopLoss || currentPrice * 0.98;
      const target = signal.target;
      const quantity = signal.quantity || this.riskManager.calculatePositionSize(currentPrice, stopLoss);

      if (quantity === 0) {
        logger.warn('Calculated quantity is 0', { signal });
        return;
      }

      const riskCheck = this.riskManager.checkOrderRisk(
        signal.symbol,
        signal.action === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
        quantity,
        currentPrice,
        stopLoss
      );

      if (!riskCheck.allowed) {
        logger.warn('Risk check failed', { signal, reason: riskCheck.reason });
        await this.telegramBot.sendAlert('Risk Check Failed', riskCheck.reason || 'Unknown reason');
        return;
      }

      // Create order with state tracking
      const order = await this.broker.placeOrder(
        signal.symbol,
        signal.action === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
        OrderType.MARKET,
        quantity,
        undefined,
        stopLoss
      );

      if (order) {
        // Track order state
        const orderRecord = orderStateManager.createOrder(order);
        orderStateManager.markOrderSubmitted(order.orderId);

        await this.telegramBot.sendTradeNotification(
          signal.action,
          signal.symbol,
          quantity,
          currentPrice,
          signal.reason
        );

        logger.audit('SIGNAL_EXECUTED', { signal, order });

        // Wait for order to fill, then place stop-loss at broker
        // In production, you'd listen for order fill events
        // For now, simulate immediate fill for market orders
        setTimeout(async () => {
          orderStateManager.updateOrderState(order.orderId, 'FILLED', quantity);

          const position = this.positionManager.getPosition(signal.symbol);
          if (position && stopLoss) {
            await this.stopLossManager.placeStopLoss(
              signal.symbol,
              order.orderId,
              position,
              stopLoss,
              target
            );
          }
        }, 1000);

      } else {
        logger.error('Failed to place order', { signal });
        await this.telegramBot.sendAlert('Order Failed', `Failed to place order for ${signal.symbol}`);
      }
    } catch (error: any) {
      logger.error('Error handling strategy signal', error);
      await this.telegramBot.sendAlert('Signal Execution Error', error.message);
    }
  });

  if (result === null) {
    logger.warn('Signal processing skipped - position lock could not be acquired', { signal });
    await this.telegramBot.sendAlert(
      'Signal Skipped',
      `Could not process signal for ${signal.symbol} - position is being modified by another operation`
    );
  }
}
```

---

## Step 5: Update Position Close Logic

Modify `closePosition` to record trade metrics and cancel stop-loss:

```typescript
private async closePosition(symbol: string, reason: string): Promise<void> {
  const position = this.positionManager.getPosition(symbol);
  if (!position) {
    logger.warn('No position to close', { symbol });
    return;
  }

  const side = position.type === 'LONG' ? OrderSide.SELL : OrderSide.BUY;
  const currentPrice = await this.broker.getLTP(symbol);

  if (!currentPrice) {
    logger.error('Cannot close position - no current price', { symbol });
    return;
  }

  const order = await this.broker.placeOrder(
    symbol,
    side,
    OrderType.MARKET,
    position.quantity
  );

  if (order) {
    logger.info('Position close order placed', { symbol, reason });

    // Track order
    orderStateManager.createOrder(order);
    orderStateManager.markOrderSubmitted(order.orderId);

    // Cancel broker-level stop-loss
    await this.stopLossManager.cancelStopLoss(symbol, reason);

    // Record trade for performance tracking
    this.performanceTracker.recordTrade({
      symbol,
      side: position.type === 'LONG' ? 'BUY' : 'SELL',
      entryPrice: position.entryPrice,
      exitPrice: currentPrice,
      quantity: position.quantity,
      entryTime: position.entryTime,
      exitTime: new Date(),
      reason
    });

    await this.telegramBot.sendTradeNotification(
      side,
      symbol,
      position.quantity,
      currentPrice,
      reason
    );

    // Send performance update
    const metrics = this.performanceTracker.getMetrics();
    await this.telegramBot.sendMessage(
      `📊 Trade Closed\n\n` +
      `Win Rate: ${metrics.winRate.toFixed(1)}%\n` +
      `Total Trades: ${metrics.totalTrades}\n` +
      `Net Profit: ₹${metrics.netProfit.toFixed(2)}\n` +
      `Expectancy: ₹${metrics.expectancy.toFixed(2)}/trade`
    );
  }
}
```

---

## Step 6: Update Start Method

Add service initialization to `start()` method:

```typescript
public async start(): Promise<void> {
  if (this.isRunning) {
    logger.warn('Trading engine already running');
    return;
  }

  logger.info('Starting trading engine', {
    mode: this.config.trading.mode,
    killSwitch: configManager.isKillSwitchActive()
  });

  const connected = await this.broker.connect();
  if (!connected) {
    throw new Error('Failed to connect to broker');
  }

  this.initialBalance = await this.broker.getAccountBalance();
  this.riskManager.resetStartingBalance(this.initialBalance);

  // Sync positions from broker on startup
  await this.reconciliationService.syncFromBroker();

  // Start position reconciliation
  this.reconciliationService.start();

  // Start stop-loss monitoring
  this.stopLossManager.startMonitoring();

  this.scheduler.start();
  this.telegramBot.start();

  this.isRunning = true;

  const startupMessage =
    `🚀 *Trading Engine Started*\n\n` +
    `Mode: ${this.config.trading.mode}\n` +
    `Balance: ₹${this.initialBalance.toLocaleString('en-IN')}\n\n` +
    `✅ Position reconciliation: Active\n` +
    `✅ Stop-loss monitoring: Active\n` +
    `✅ Performance tracking: Active`;

  await this.telegramBot.sendMessage(startupMessage);

  logger.info('Trading engine started successfully');
  logger.audit('TRADING_ENGINE_STARTED', {
    mode: this.config.trading.mode,
    balance: this.initialBalance
  });
}
```

---

## Step 7: Update Stop Method

Add service cleanup to `stop()` method:

```typescript
public async stop(): Promise<void> {
  if (!this.isRunning) {
    logger.warn('Trading engine not running');
    return;
  }

  logger.info('Stopping trading engine');

  await this.stopStrategies();
  await this.closeAllPositions('Engine shutdown');

  // Stop services
  this.reconciliationService.stop();
  this.stopLossManager.stopMonitoring();

  // Cancel all broker-level stop-losses
  await this.stopLossManager.cancelAllStopLosses('Engine shutdown');

  // Release all position locks
  positionLockManager.releaseAllLocks();

  this.scheduler.stop();
  await this.telegramBot.stop();
  await this.broker.disconnect();

  // Send final performance report
  const performanceSummary = this.performanceTracker.getPerformanceSummary();
  await this.telegramBot.sendMessage(
    `🏁 *Trading Session Ended*\n\n${performanceSummary}`
  );

  this.isRunning = false;

  logger.info('Trading engine stopped');
  logger.audit('TRADING_ENGINE_STOPPED', {});
}
```

---

## Step 8: Optional - WebSocket Integration

To use WebSocket instead of polling (for REAL mode only):

```typescript
private initializeBroker(): IBroker {
  if (this.config.trading.mode === TradingMode.PAPER) {
    logger.info('Initializing PAPER trading mode with REAL data');
    return new PaperBroker(
      1000000,
      this.config.broker,
      this.config.telegram
    );
  } else {
    logger.info('Initializing REAL trading mode');
    const broker = new AngelOneBroker(this.config.broker);

    // Initialize WebSocket for real-time data
    // Note: You'll need to add getClient() method to AngelOneBroker
    // to expose the underlying AngelOneClient
    // this.websocketFeed = new WebSocketDataFeed(broker.getClient());

    return broker;
  }
}
```

---

## Step 9: Add Helper Methods

Add these useful helper methods to `TradingEngine`:

```typescript
/**
 * Get current performance metrics
 */
public getPerformanceMetrics() {
  return this.performanceTracker.getMetrics();
}

/**
 * Get performance summary as formatted text
 */
public getPerformanceSummary(): string {
  return this.performanceTracker.getPerformanceSummary();
}

/**
 * Get order statistics
 */
public getOrderStatistics() {
  return orderStateManager.getStatistics();
}

/**
 * Get stop-loss statistics
 */
public getStopLossStatistics() {
  return this.stopLossManager.getStatistics();
}

/**
 * Force position reconciliation
 */
public async forceReconciliation(): Promise<void> {
  await this.reconciliationService.forceReconcile();
}
```

---

## Step 10: Testing Checklist

After integration, test these scenarios:

### Basic Functionality
- [ ] Bot starts successfully
- [ ] Positions sync from broker on startup
- [ ] Orders are tracked in state manager
- [ ] Stop-losses are placed at broker after entry fills
- [ ] Position reconciliation runs every 5 minutes
- [ ] Performance metrics are calculated correctly

### Error Scenarios
- [ ] Order rejection is handled
- [ ] Order timeout is detected
- [ ] Position mismatch is detected and fixed
- [ ] Stop-loss triggers are detected
- [ ] Target hits are detected

### Cleanup
- [ ] Bot stops gracefully
- [ ] All stop-losses are cancelled on shutdown
- [ ] Position locks are released
- [ ] Services are stopped properly
- [ ] Final performance report is sent

---

## Common Issues & Solutions

### Issue: PositionManager doesn't have getPositionsMap()

**Solution:** Add this method to `PositionManager`:

```typescript
public getPositionsMap(): Map<string, Position> {
  return this.positions; // Assuming positions is the internal Map
}
```

### Issue: Can't access AngelOneClient from broker

**Solution:** Add getter to `AngelOneBroker`:

```typescript
public getClient(): AngelOneClient {
  return this.client;
}
```

### Issue: Order fills not detected

**Solution:** Poll order status or implement webhook:

```typescript
private async pollOrderStatus(orderId: string): Promise<void> {
  const maxAttempts = 10;
  let attempts = 0;

  const interval = setInterval(async () => {
    attempts++;
    const orders = await this.broker.getOrders();
    const order = orders.find(o => o.orderId === orderId);

    if (order && order.status === 'FILLED') {
      orderStateManager.updateOrderState(orderId, 'FILLED', order.filledQuantity);
      clearInterval(interval);
    }

    if (attempts >= maxAttempts) {
      clearInterval(interval);
    }
  }, 1000);
}
```

---

## Performance Considerations

1. **Order State Cleanup:** Run daily cleanup:
   ```typescript
   // In scheduler daily reset
   orderStateManager.cleanupOldOrders(7); // Keep 7 days
   ```

2. **Memory Management:** The services store data in memory. For long-running bots:
   - Periodically save metrics to disk
   - Implement data rotation
   - Monitor memory usage

3. **API Rate Limits:**
   - Stop-loss monitoring: 10 seconds is safe
   - Position reconciliation: 5 minutes is safe
   - WebSocket: No rate limits (streaming)

---

## Final Notes

- All services are designed to work independently
- You can enable them selectively if needed
- Each service has comprehensive logging
- Audit trail is maintained for compliance
- Error handling is built-in

**Test thoroughly in paper mode before going live!**
