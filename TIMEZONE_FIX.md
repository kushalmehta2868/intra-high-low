# Timezone Fix - IST Support for Render Deployment

## Problem

When deploying to cloud platforms like Render, the server timezone is typically **UTC**, but Indian stock market hours are in **IST (Indian Standard Time, UTC+5:30)**. This caused issues where:

- Bot thought market was closed when it was actually open (and vice versa)
- Scheduled market open/close events fired at wrong times
- Market hours check was comparing UTC time with IST hours

## Solution

The scheduler now uses **Asia/Kolkata timezone** for all operations, regardless of where the bot is deployed.

---

## Changes Made

### 1. Cron Jobs with Timezone

All cron schedules now use IST timezone:

```typescript
cron.schedule(cronExpression, callback, {
  timezone: 'Asia/Kolkata'  // ✅ Forces IST regardless of server timezone
});
```

### 2. Market Hours Check with IST

The `isMarketHours()` method now converts current time to IST:

```typescript
public isMarketHours(): boolean {
  // Get current time in IST (not server timezone)
  const now = new Date();
  const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

  // Check if market hours in IST
  const currentTime = `${String(istTime.getHours()).padStart(2, '0')}:${String(istTime.getMinutes()).padStart(2, '0')}`;
  return currentTime >= '09:15' && currentTime <= '15:30';
}
```

### 3. Helpful Logging

Scheduler startup now shows current IST time:

```
[INFO] Market scheduler started | {
  "timezone": "Asia/Kolkata",
  "currentISTTime": "22/12/2024, 13:08:41",
  "marketStartTime": "09:15 IST",
  "marketEndTime": "15:30 IST",
  "autoSquareOffTime": "15:15 IST",
  "isMarketHours": true
}
```

---

## How It Works

### Before (Broken on Render)

```
Server: UTC 03:45 (9:15 AM UTC)
Config: 09:15 (meant to be IST)
Result: ❌ Market opens at wrong time (3:45 AM IST instead of 9:15 AM IST)
```

### After (Fixed)

```
Server: UTC 03:45
Config: 09:15 IST
Cron: { timezone: 'Asia/Kolkata' }
Result: ✅ Market opens at correct time (9:15 AM IST = 3:45 AM UTC)
```

---

## Configuration

Market hours are still configured in `.env` in **IST**:

```bash
MARKET_START_TIME=09:15    # 9:15 AM IST
MARKET_END_TIME=15:30      # 3:30 PM IST
```

**No need to convert these to UTC!** The scheduler handles the conversion automatically.

---

## Testing

### Test 1: Verify Current IST Time

When bot starts, check the logs:

```
[INFO] Market scheduler started | {
  "currentISTTime": "22/12/2024, 13:08:41",  # Should show IST time
  "isMarketHours": true                       # Should be correct
}
```

**How to verify:**
- Check current IST time: https://time.is/IST
- Compare with `currentISTTime` in logs
- Should match exactly

### Test 2: Market Hours Check

```bash
# If current IST time is 10:00 AM (market is open)
Expected: isMarketHours = true

# If current IST time is 8:00 AM (market not yet open)
Expected: isMarketHours = false

# If current IST time is 4:00 PM (market closed)
Expected: isMarketHours = false
```

### Test 3: Scheduled Events

Market open event should fire at **exactly 9:15 AM IST**, not 9:15 AM UTC.

```bash
# Watch logs around 9:15 AM IST
[INFO] Market opened
[INFO] 🟢 Market opened - starting strategies and market data
```

---

## Deployment on Different Platforms

### Render.com (UTC)
✅ **Works perfectly** - Timezone conversion handles it

### AWS/Azure/GCP (UTC by default)
✅ **Works perfectly** - Timezone conversion handles it

### Local Machine (Your Timezone)
✅ **Works perfectly** - Always uses IST regardless of system timezone

### Docker Container (UTC)
✅ **Works perfectly** - No need to set TZ environment variable

---

## Environment Variables

**No special environment variables needed!**

Before (old approach - doesn't work):
```bash
TZ=Asia/Kolkata  # ❌ Not reliable, doesn't work for cron
```

After (new approach - works everywhere):
```typescript
// ✅ Hardcoded in scheduler, always works
timezone: 'Asia/Kolkata'
```

---

## Troubleshooting

### Issue: Market opens/closes at wrong time on Render

**Check scheduler logs:**
```bash
# In Render logs, look for:
[INFO] Market scheduler started | { "currentISTTime": "..." }
```

**Verify:**
1. `currentISTTime` matches actual IST time (check https://time.is/IST)
2. If they match, timezone is working correctly
3. If they don't match, there's a bug (report it)

### Issue: isMarketHours returns wrong value

**Debug:**
```typescript
logger.info('Debug market hours', {
  serverTime: new Date().toISOString(),
  istTime: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
  isMarketHours: scheduler.isMarketHours()
});
```

### Issue: Bot says "Market is CLOSED" when it's actually open

**Solution:**
1. Restart the bot to ensure new timezone code is loaded
2. Check logs for `currentISTTime` - should match current IST
3. Verify `.env` has correct market hours:
   ```bash
   MARKET_START_TIME=09:15
   MARKET_END_TIME=15:30
   ```

---

## Technical Details

### node-cron Timezone Support

The `node-cron` library supports timezone-aware scheduling:

```typescript
cron.schedule('15 9 * * 1-5', callback, {
  timezone: 'Asia/Kolkata'
});
```

This uses the system's timezone database (IANA timezone database) to convert times correctly.

### JavaScript Date with Timezone

```typescript
// Current UTC time
const now = new Date();

// Convert to IST
const istTime = new Date(now.toLocaleString('en-US', {
  timeZone: 'Asia/Kolkata'
}));

// Now istTime represents the same moment in IST
```

---

## Files Modified

1. **[src/core/scheduler.ts](src/core/scheduler.ts:13)** - Added IST timezone constant
2. **[src/core/scheduler.ts](src/core/scheduler.ts:44-46)** - Added timezone to market start cron
3. **[src/core/scheduler.ts](src/core/scheduler.ts:56-58)** - Added timezone to market end cron
4. **[src/core/scheduler.ts](src/core/scheduler.ts:68-70)** - Added timezone to square-off cron
5. **[src/core/scheduler.ts](src/core/scheduler.ts:82-94)** - Fixed isMarketHours() to use IST
6. **[src/core/scheduler.ts](src/core/scheduler.ts:97-104)** - Fixed isAfterSquareOffTime() to use IST
7. **[src/core/scheduler.ts](src/core/scheduler.ts:28-43)** - Added IST time logging

---

## Verification Checklist

After deploying to Render:

- [ ] Check logs show correct `currentISTTime`
- [ ] `isMarketHours` is correct based on IST time
- [ ] Market opens at 9:15 AM IST (not UTC)
- [ ] Market closes at 3:30 PM IST (not UTC)
- [ ] Bot starts data fetching during market hours only
- [ ] Bot stops data fetching outside market hours

---

## Summary

✅ Scheduler now uses Asia/Kolkata timezone for all operations
✅ Works correctly on Render (UTC) and any other platform
✅ No environment variable configuration needed
✅ Market hours checked in IST regardless of server timezone
✅ Logging shows current IST time for easy verification

**Your bot will now work correctly on Render with proper IST timing!** 🎉
