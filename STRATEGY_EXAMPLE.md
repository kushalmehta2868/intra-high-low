# Day High/Low Breakout Strategy - Simulated Example

## Strategy Logic

### Buy Signal (Cross ABOVE day high)
**Condition:** `prevLtp <= dayHigh AND ltp > dayHigh`

### Sell Signal (Cross BELOW day low)
**Condition:** `prevLtp >= dayLow AND ltp < dayLow`

---

## Simulated Tick Data Example

Let's simulate a trading day for symbol **RELIANCE**:

### Scenario 1: High Breakout (BUY Signal)

```
Time      | LTP    | dayHigh | dayLow  | prevLtp | Cross Check                              | Signal?
----------|--------|---------|---------|---------|------------------------------------------|----------
09:15:00  | 2500   | 2500    | 2500    | 0       | Initialization                           | NO
09:15:30  | 2502   | 2502    | 2500    | 2500    | prevLtp (2500) <= dayHigh (2500) ✓       | NO (ltp NOT > dayHigh)
09:16:00  | 2498   | 2502    | 2498    | 2502    | prevLtp (2502) > dayHigh (2502) ✗        | NO
09:16:30  | 2501   | 2502    | 2498    | 2498    | prevLtp (2498) <= dayHigh (2502) ✓       | NO (ltp NOT > dayHigh)
09:17:00  | 2503   | 2503    | 2498    | 2501    | prevLtp (2501) <= dayHigh (2502) ✓       | YES! ✓✓✓
                                                  | ltp (2503) > dayHigh (2502) ✓            |
----------|--------|---------|---------|---------|------------------------------------------|----------
```

**🚀 BUY SIGNAL TRIGGERED at 09:17:00**
- Entry Price: ₹2503
- Day High at trigger: ₹2502
- Previous LTP: ₹2501
- Cross Confirmation: `prevLtp (2501) <= dayHigh (2502) AND ltp (2503) > dayHigh (2502)` ✓
- Stop Loss: ₹2490.50 (0.5% below entry)
- Target: ₹2540.95 (1.5% above entry)
- Risk/Reward: 1:3

**Flag Set:** `hasBrokenHighToday = true` (prevents duplicate signals)

```
09:17:30  | 2505   | 2505    | 2498    | 2503    | hasBrokenHighToday = true                | NO (already triggered)
09:18:00  | 2510   | 2510    | 2498    | 2505    | hasBrokenHighToday = true                | NO (already triggered)
```

---

### Scenario 2: Low Breakout (SELL Signal)

```
Time      | LTP    | dayHigh | dayLow  | prevLtp | Cross Check                              | Signal?
----------|--------|---------|---------|---------|------------------------------------------|----------
09:15:00  | 2500   | 2500    | 2500    | 0       | Initialization                           | NO
09:15:30  | 2498   | 2500    | 2498    | 2500    | prevLtp (2500) >= dayLow (2500) ✓        | NO (ltp NOT < dayLow)
09:16:00  | 2502   | 2502    | 2498    | 2498    | prevLtp (2498) < dayLow (2498) ✗         | NO
09:16:30  | 2499   | 2502    | 2498    | 2502    | prevLtp (2502) >= dayLow (2498) ✓        | NO (ltp NOT < dayLow)
09:17:00  | 2497   | 2502    | 2497    | 2499    | prevLtp (2499) >= dayLow (2498) ✓        | YES! ✓✓✓
                                                  | ltp (2497) < dayLow (2498) ✓             |
----------|--------|---------|---------|---------|------------------------------------------|----------
```

**📉 SELL SIGNAL TRIGGERED at 09:17:00**
- Entry Price: ₹2497
- Day Low at trigger: ₹2498
- Previous LTP: ₹2499
- Cross Confirmation: `prevLtp (2499) >= dayLow (2498) AND ltp (2497) < dayLow (2498)` ✓
- Stop Loss: ₹2509.49 (0.5% above entry)
- Target: ₹2459.55 (1.5% below entry)
- Risk/Reward: 1:3

**Flag Set:** `hasBrokenLowToday = true` (prevents duplicate signals)

```
09:17:30  | 2495   | 2502    | 2495    | 2497    | hasBrokenLowToday = true                 | NO (already triggered)
09:18:00  | 2490   | 2502    | 2490    | 2495    | hasBrokenLowToday = true                 | NO (already triggered)
```

---

### Scenario 3: NO Signal (Price stays within range)

```
Time      | LTP    | dayHigh | dayLow  | prevLtp | Cross Check                              | Signal?
----------|--------|---------|---------|---------|------------------------------------------|----------
09:15:00  | 2500   | 2500    | 2500    | 0       | Initialization                           | NO
09:15:30  | 2502   | 2502    | 2500    | 2500    | prevLtp (2500) <= dayHigh (2500) ✓       | NO (ltp NOT > dayHigh)
09:16:00  | 2501   | 2502    | 2500    | 2502    | prevLtp (2502) > dayHigh (2502) ✗        | NO
09:16:30  | 2500   | 2502    | 2500    | 2501    | Price at dayLow boundary                 | NO (ltp NOT < dayLow)
09:17:00  | 2501   | 2502    | 2500    | 2500    | Price consolidating                      | NO
09:17:30  | 2502   | 2502    | 2500    | 2501    | Price at dayHigh boundary                | NO (ltp NOT > dayHigh)
----------|--------|---------|---------|---------|------------------------------------------|----------
```

**No signal triggered** - Price is consolidating within the day's range.

---

### Scenario 4: False Breakout Prevention

**Why we use cross logic instead of simple >= or <=:**

#### Without Cross Logic (WRONG - Multiple Triggers):
```
Time      | LTP    | dayHigh | Simple Check (ltp > dayHigh)             | Signals
----------|--------|---------|------------------------------------------|----------
09:15:00  | 2500   | 2500    | 2500 > 2500? NO                          | NO
09:15:30  | 2503   | 2503    | 2503 > 2500? YES ✓                       | BUY #1
09:16:00  | 2505   | 2505    | 2505 > 2503? YES ✓                       | BUY #2 (duplicate!)
09:16:30  | 2507   | 2507    | 2507 > 2505? YES ✓                       | BUY #3 (duplicate!)
----------|--------|---------|------------------------------------------|----------
```
❌ **Problem:** Multiple signals triggered!

#### With Cross Logic (CORRECT - Single Trigger):
```
Time      | LTP    | dayHigh | prevLtp | Cross Check                              | Signals
----------|--------|---------|---------|------------------------------------------|----------
09:15:00  | 2500   | 2500    | 0       | Initialization                           | NO
09:15:30  | 2503   | 2503    | 2500    | prevLtp (2500) <= dayHigh (2500) ✓       | BUY #1 ✓
                                        | ltp (2503) > dayHigh (2500) ✓            |
                                        | hasBrokenHighToday = true                |
09:16:00  | 2505   | 2505    | 2503    | hasBrokenHighToday = true                | NO (flag prevents duplicate)
09:16:30  | 2507   | 2507    | 2505    | hasBrokenHighToday = true                | NO (flag prevents duplicate)
----------|--------|---------|---------|------------------------------------------|----------
```
✅ **Solution:** Only ONE signal triggered!

---

## Key Features

### 1. Cross Detection Logic
- **Buy:** Only triggers when price **crosses from below to above** day high
- **Sell:** Only triggers when price **crosses from above to below** day low
- Uses `prevLtp` to track the previous tick's price

### 2. Single Signal Per Day
- `hasBrokenHighToday` flag prevents multiple BUY signals
- `hasBrokenLowToday` flag prevents multiple SELL signals
- Flags reset at market open next day

### 3. Risk Management
- **Stop Loss:** 0.5% from entry (tight control)
- **Target:** 1.5% from entry (3x reward)
- **Risk/Reward Ratio:** 1:3 (favorable odds)

### 4. No Additional Filters
- Pure price action based on day's high/low
- No momentum requirements
- No volume confirmation
- Simple and clean logic

---

## Code Flow

```typescript
1. Market Data arrives: { symbol: 'RELIANCE', ltp: 2503, high: 2503, low: 2498 }

2. Update day high/low:
   state.dayHigh = Math.max(state.dayHigh, data.high, data.ltp)
   state.dayLow = Math.min(state.dayLow, data.low, data.ltp)

3. Check for cross:
   const crossedAboveHigh = prevLtp <= dayHigh && ltp > dayHigh

4. If crossed and not already triggered:
   if (crossedAboveHigh && !state.hasBrokenHighToday) {
     state.hasBrokenHighToday = true
     on_buy_signal(symbol, ltp, dayHigh, prevLtp)
   }

5. Update prevLtp:
   state.prevLtp = data.ltp
```

---

## Expected Performance

With 1:3 risk/reward ratio:
- **Break-even win rate:** 25% (only need to win 1 out of 4 trades!)
- **At 40% win rate:** ~60% profit
- **At 50% win rate:** ~100% profit

**Key Advantage:** Even with low win rate, strategy remains profitable due to superior risk/reward.

---

## Integration with Trading Engine

When signal is generated, it will be sent to the trading engine with:
- **Symbol:** e.g., "RELIANCE"
- **Action:** "BUY" or "SELL"
- **Stop Loss:** Calculated price
- **Target:** Calculated price
- **Reason:** Description of the cross

The trading engine will:
1. Calculate position size based on risk limits
2. Place market order
3. Place broker-level stop-loss order
4. Place target order
5. Monitor position until exit
