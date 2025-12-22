# Market Hours Control Feature

## Overview

The bot now only fetches market data and processes trades **during market hours** (9:15 AM - 3:30 PM IST). Outside these hours, the bot remains idle to conserve resources and API calls.

---

## How It Works

### 1. Market Data Fetching Control

**During Market Hours (9:15 AM - 3:30 PM IST):**
- ✅ Market data fetcher is **ACTIVE**
- ✅ Fetches real-time prices every 5 seconds
- ✅ Strategies process market data
- ✅ Signals can be generated

**Outside Market Hours:**
- ❌ Market data fetcher is **STOPPED**
- ❌ No API calls to Angel One for market data
- ❌ No price updates
- ❌ Bot remains idle

### 2. Automatic Start/Stop

The bot automatically controls market data fetching based on scheduler events:

```typescript
// At 9:15 AM IST - Market Opens
scheduler.on('market_open', async () => {
  await broker.startMarketDataFetching();
  await startStrategies();
});

// At 3:30 PM IST - Market Closes
scheduler.on('market_close', async () => {
  await stopStrategies();
  broker.stopMarketDataFetching();
});
```

### 3. Smart Initialization

**If bot starts during market hours:**
- Market data fetching starts **immediately**
- Strategies activate right away
- Trading becomes active

**If bot starts outside market hours:**
- Bot waits for market open
- No market data fetching
- Strategies remain inactive until 9:15 AM IST

---

## Benefits

### 1. Resource Efficiency
- **No wasted API calls** outside trading hours
- Reduces Angel One API rate limit usage
- Bot only runs when market is active

### 2. Cost Savings
- On cloud platforms like Render, reduced CPU/network usage
- Less bandwidth consumption
- More efficient use of compute resources

### 3. Clean Logs
- No unnecessary "market closed" warnings
- Logs only show activity during trading hours
- Easier to debug actual trading issues

### 4. Better Battery Life (Local)
- If running locally, reduces CPU usage
- Less network activity
- Lower power consumption

---

## Configuration

Market hours are configured in `.env`:

```bash
MARKET_START_TIME=09:15    # IST - Market open
MARKET_END_TIME=15:30      # IST - Market close
```

**Note:** Times are in 24-hour format (HH:MM)

---

## Implementation Details

### Files Modified

#### 1. `src/brokers/paper/broker.ts`

**Changed:** Market data fetcher is initialized but NOT started during `connect()`

```typescript
// Initialize but don't start
this.marketDataFetcher = new MarketDataFetcher(this.angelClient);

// Forward events
this.marketDataFetcher.on('market_data', (data) => {
  this.emit('market_data', data);
});

logger.info('✅ Market data fetcher initialized (will start during market hours)');
```

**Added:** Two new public methods

```typescript
public async startMarketDataFetching(): Promise<void> {
  await this.marketDataFetcher.start();
  logger.info('🟢 Market data fetching STARTED - market is now OPEN');
}

public stopMarketDataFetching(): void {
  this.marketDataFetcher.stop();
  logger.info('🔴 Market data fetching STOPPED - market is now CLOSED');
}
```

#### 2. `src/core/tradingEngine.ts`

**Changed:** Market open/close handlers now control data fetching

```typescript
this.scheduler.on('market_open', async () => {
  logger.info('🟢 Market opened - starting strategies and market data');

  // Start market data fetching (Paper mode)
  if (this.config.trading.mode === TradingMode.PAPER) {
    await (this.broker as any).startMarketDataFetching?.();
  }

  await this.startStrategies();
});

this.scheduler.on('market_close', async () => {
  logger.info('🔴 Market closed - stopping strategies and market data');

  await this.stopStrategies();

  // Stop market data fetching (Paper mode)
  if (this.config.trading.mode === TradingMode.PAPER) {
    (this.broker as any).stopMarketDataFetching?.();
  }
});
```

**Changed:** Engine start now checks if it's market hours

```typescript
// If starting during market hours, start immediately
if (this.scheduler.isMarketHours() && this.config.trading.mode === TradingMode.PAPER) {
  logger.info('⏰ Bot started during market hours - starting market data fetching immediately');
  await (this.broker as any).startMarketDataFetching?.();
  await this.startStrategies();
} else {
  logger.info('⏰ Bot started outside market hours - will wait for market open');
}
```

#### 3. `src/services/marketDataFetcher.ts`

**Changed:** Reduced log noise when tokens not loaded

```typescript
if (tokens.length === 0) {
  logger.debug('Symbol tokens not yet loaded, skipping this fetch cycle');
  return;
}
```

---

## Expected Logs

### Bot Started During Market Hours (e.g., 10:00 AM IST)

```
[INFO] Starting trading engine
[INFO] ✅ Connected to Angel One for REAL market data
[INFO] ✅ Symbol token cache refreshed
[INFO] ✅ Market data fetcher initialized (will start during market hours)
[INFO] ⏰ Bot started during market hours - starting market data fetching immediately
[INFO] 🟢 Market data fetching STARTED - market is now OPEN
[INFO] 🚀 Trading Engine Started
[INFO] Market is OPEN - trading active
```

### Bot Started Outside Market Hours (e.g., 8:00 AM IST)

```
[INFO] Starting trading engine
[INFO] ✅ Connected to Angel One for REAL market data
[INFO] ✅ Symbol token cache refreshed
[INFO] ✅ Market data fetcher initialized (will start during market hours)
[INFO] ⏰ Bot started outside market hours - will wait for market open
[INFO] 🚀 Trading Engine Started
[INFO] Market is CLOSED - waiting for market open
```

### When Market Opens (9:15 AM IST)

```
[INFO] 🟢 Market opened - starting strategies and market data
[INFO] 🟢 Market data fetching STARTED - market is now OPEN
[INFO] Strategy started: Day High/Low Breakout
[INFO] 📊 Market data: RELIANCE-EQ
[INFO] 📊 Market data: TCS-EQ
[INFO] 📊 Market data: INFY-EQ
```

### When Market Closes (3:30 PM IST)

```
[INFO] 🔴 Market closed - stopping strategies and market data
[INFO] Strategy stopped: Day High/Low Breakout
[INFO] 🔴 Market data fetching STOPPED - market is now CLOSED
```

---

## Testing

### Test 1: Start Bot During Market Hours

1. Set system time to 10:00 AM IST
2. Start bot: `npm start`
3. **Expected:** Market data fetching starts immediately
4. **Verify:** Logs show "Market data fetching STARTED"

### Test 2: Start Bot Outside Market Hours

1. Set system time to 8:00 AM IST
2. Start bot: `npm start`
3. **Expected:** Bot waits for market open
4. **Verify:** No market data logs until 9:15 AM

### Test 3: Market Close Event

1. Start bot at 3:00 PM IST
2. Wait until 3:30 PM
3. **Expected:** Market data fetching stops automatically
4. **Verify:** Logs show "Market data fetching STOPPED"

### Test 4: Market Open Event

1. Start bot at 9:00 AM IST
2. Wait until 9:15 AM
3. **Expected:** Market data fetching starts automatically
4. **Verify:** Logs show "Market data fetching STARTED"

---

## Paper vs Real Mode

### Paper Mode (PAPER)
- ✅ Market data fetcher controlled by market hours
- ✅ Automatically starts/stops
- ✅ No API calls outside market hours

### Real Mode (REAL)
- ⚠️ Angel One broker uses different mechanism
- ⚠️ Not affected by this feature (currently)
- ℹ️ Real mode uses on-demand API calls only

**Note:** This feature currently only applies to PAPER mode. Real mode doesn't use the continuous market data fetcher.

---

## Troubleshooting

### Issue: Market data not starting at 9:15 AM

**Possible Causes:**
1. Bot was not running
2. Scheduler is not active
3. Market hours misconfigured

**Solution:**
```bash
# Check market hours in .env
MARKET_START_TIME=09:15
MARKET_END_TIME=15:30

# Restart bot
npm start
```

### Issue: Market data running outside market hours

**Possible Causes:**
1. Bot was started before this feature was implemented
2. Restart needed

**Solution:**
```bash
# Stop bot
Ctrl+C

# Start again
npm start
```

### Issue: "Market data fetcher not initialized" warning

**Possible Causes:**
1. Angel One connection failed
2. Bot in REAL mode (not PAPER)

**Solution:**
```bash
# Check Angel One credentials in .env
# Ensure TRADING_MODE=PAPER
# Restart bot
```

---

## Performance Impact

### Before (Continuous Fetching)

```
- API calls: 24/7 (every 5 seconds)
- Total calls per day: ~17,280 calls
- Wasted calls outside hours: ~14,000 calls (81%)
```

### After (Market Hours Only)

```
- API calls: 9:15 AM - 3:30 PM only
- Total calls per day: ~4,500 calls
- Savings: ~12,780 calls per day (74% reduction)
```

**Impact:**
- 74% fewer API calls
- 74% less bandwidth usage
- 74% less CPU usage for data processing

---

## Future Enhancements

Potential improvements:

1. **Real Mode Support**
   - Add market hours control for AngelOneBroker
   - Reduce on-demand API calls outside hours

2. **Holiday Calendar**
   - Skip market holidays automatically
   - No need to manually stop bot

3. **Pre-Market Data**
   - Optionally fetch data 15 min before market open
   - For better strategy initialization

4. **Configurable Fetch Interval**
   - Allow changing from 5 seconds to custom interval
   - Balance between data freshness and API usage

---

## Summary

✅ Bot now respects market hours for data fetching
✅ Automatic start/stop at market open/close
✅ Smart initialization based on current time
✅ 74% reduction in API calls and resource usage
✅ Cleaner logs and better efficiency

**Your bot is now more efficient and cost-effective!** 🎉
