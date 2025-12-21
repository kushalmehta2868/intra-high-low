# 15-Minute Cooldown Feature

## Overview

The strategy now implements a **15-minute cooldown period** after a position closes, preventing re-entry into the same symbol too quickly.

---

## How It Works

### 1. Position Active
When a position is open for a symbol (e.g., TCS):
- ✅ Symbol is actively traded
- ❌ No new signals generated for that symbol
- 📊 Price tracking continues

### 2. Position Closes (Target Hit or Stop Loss)
When the position closes:
- 🔒 **15-minute cooldown starts immediately**
- ⏰ Timestamp is recorded (`positionClosedAt`)
- 🚫 Symbol is marked as `isInCooldown = true`
- 📝 Log shows cooldown start and end time

**Example Log:**
```
🔒 [TCS] Position closed - 15-minute cooldown started
  closedAt: 10:30:00 AM
  cooldownEndsAt: 10:45:00 AM
```

### 3. During Cooldown (15 Minutes)
- ❌ No new signals generated
- 📊 Price tracking continues
- ✅ Cross detection is **skipped** for the symbol
- 🔄 Other symbols can still generate signals

### 4. Cooldown Expires (After 15 Minutes)
- ✅ Symbol becomes available for new signals
- 🔓 `isInCooldown = false`
- 🔄 Breakout flags reset (`hasBrokenHighToday`, `hasBrokenLowToday`)
- 📝 Ready for new cross detection

**Example Log:**
```
⏰ [TCS] Cooldown period ended - ready for new signals
  cooldownDuration: 15.0 minutes
```

---

## Example Timeline

### Scenario: TCS High Breakout

```
Time      | Event                          | State                    | Can Trade?
----------|--------------------------------|--------------------------|------------
09:30:00  | Market opens                   | Normal                   | ✅ Yes
09:45:00  | TCS crosses above day high     | Signal generated         | ✅ Yes
09:45:05  | BUY position opened            | Position active          | ❌ No (position exists)
09:50:00  | Price hits target              | Position closes          | ❌ No (cooldown starts)
09:50:00  | 15-min cooldown starts         | isInCooldown = true      | ❌ No (in cooldown)
10:00:00  | (Still in cooldown)            | isInCooldown = true      | ❌ No (in cooldown)
10:05:00  | Cooldown expires               | isInCooldown = false     | ✅ Yes
10:05:30  | TCS crosses above new high     | Signal generated         | ✅ Yes
```

---

## Code Implementation

### State Tracking

```typescript
interface SymbolState {
  // ... other fields

  // Cooldown tracking
  positionClosedAt: number | null;  // Timestamp when position closed
  isInCooldown: boolean;            // Whether in cooldown period
}
```

### Cooldown Configuration

```typescript
private readonly COOLDOWN_PERIOD_MS = 15 * 60 * 1000; // 15 minutes
```

### Cooldown Check (Every Tick)

```typescript
private checkCooldownExpiry(symbol: string, state: SymbolState): void {
  if (state.isInCooldown && state.positionClosedAt !== null) {
    const now = Date.now();
    const timeSinceClose = now - state.positionClosedAt;

    if (timeSinceClose >= this.COOLDOWN_PERIOD_MS) {
      // Cooldown expired - reset flags
      state.isInCooldown = false;
      state.positionClosedAt = null;
      state.hasBrokenHighToday = false;
      state.hasBrokenLowToday = false;
    }
  }
}
```

### Signal Generation (Skips Cooldown)

```typescript
private checkForBreakout(data: MarketData, state: SymbolState): void {
  // Skip if position exists
  if (existingPosition) return;

  // Skip if in cooldown ✨ NEW
  if (state.isInCooldown) return;

  // Continue with cross detection...
}
```

### Position Close Handler

```typescript
public onPositionUpdate(position: Position): void {
  if (position.quantity === 0) {
    // Position closed - start cooldown
    state.positionClosedAt = Date.now();
    state.isInCooldown = true;

    logger.info('🔒 Position closed - 15-minute cooldown started');
  }
}
```

---

## Benefits

### 1. Prevents Overtrading
- Avoids rapid re-entry after stop loss
- Gives time for price to stabilize
- Reduces trading costs (brokerage, slippage)

### 2. Emotional Discipline
- Forces a "cooldown" period after a trade
- Prevents revenge trading
- Encourages patience

### 3. Better Risk Management
- Limits exposure to same symbol
- Prevents accumulating losses in whipsawing markets
- Allows other symbols to generate signals

### 4. Market Breathing Room
- Gives the symbol time to establish new range
- Avoids false breakouts immediately after exit
- Better quality entries

---

## Multiple Symbols Behavior

The cooldown is **per-symbol**, not global:

```
Time      | TCS State        | RELIANCE State   | INFY State
----------|------------------|------------------|----------------
10:00:00  | In cooldown      | Can trade ✅     | Can trade ✅
10:05:00  | Cooldown ends ✅ | In cooldown      | Can trade ✅
10:10:00  | Can trade ✅     | In cooldown      | In cooldown
10:20:00  | Can trade ✅     | Cooldown ends ✅ | Cooldown ends ✅
```

**Each symbol has independent cooldown tracking!**

---

## Daily Reset

At the start of each trading day:
```typescript
state.positionClosedAt = null;
state.isInCooldown = false;
state.hasBrokenHighToday = false;
state.hasBrokenLowToday = false;
```

All symbols start fresh with no cooldowns.

---

## Adjusting Cooldown Period

To change the cooldown duration, modify this constant:

```typescript
// In DayHighLowBreakoutStrategy class
private readonly COOLDOWN_PERIOD_MS = 15 * 60 * 1000; // 15 minutes

// Examples for different durations:
// 5 minutes:  5 * 60 * 1000
// 10 minutes: 10 * 60 * 1000
// 30 minutes: 30 * 60 * 1000
// 1 hour:     60 * 60 * 1000
```

---

## Logging

### Position Close
```
🔒 [TCS] Position closed - 15-minute cooldown started
  closedAt: 10:30:00 AM
  cooldownEndsAt: 10:45:00 AM
```

### Cooldown Expiry
```
⏰ [TCS] Cooldown period ended - ready for new signals
  cooldownDuration: 15.0 minutes
```

### During Cooldown (No logs)
- Cross detection silently skipped
- No spam in logs
- Clean and efficient

---

## Testing

### Manual Test Scenario

1. **Start bot** with TCS in watchlist
2. **Wait for signal** (TCS crosses day high)
3. **Position opens** → Check: No new TCS signals
4. **Position closes** (hit target/stop) → Check log for cooldown start
5. **Wait 15 minutes** → Check log for cooldown end
6. **New signal** should now be possible

### Expected Behavior

✅ Only ONE position per symbol at a time
✅ 15-minute gap after position closes
✅ Multiple symbols can trade independently
✅ Daily reset clears all cooldowns
✅ Clean logging without spam

---

## Summary

The 15-minute cooldown feature:
- ✅ Prevents re-entry immediately after exit
- ✅ Works per-symbol (independent tracking)
- ✅ Automatically expires after 15 minutes
- ✅ Resets daily at market open
- ✅ Clean implementation with clear logging

**Trade smarter, not faster!** 🎯
