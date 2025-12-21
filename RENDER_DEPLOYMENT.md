# Render Deployment Guide - Angel Intraday Trading Bot

Complete guide to deploy your trading bot on Render.com

---

## 🚀 Quick Start

### Prerequisites
- GitHub account
- Render account (free: https://render.com)
- Angel One API credentials
- Telegram bot token

---

## 📋 Step-by-Step Deployment

### 1. Prepare Your Repository

**Push code to GitHub:**

```bash
# Initialize git (if not already done)
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit - Trading bot ready for deployment"

# Add remote (replace with your repo URL)
git remote add origin https://github.com/YOUR_USERNAME/angel-intraday-bot.git

# Push to GitHub
git push -u origin main
```

**⚠️ IMPORTANT:** Make sure `.env` is in `.gitignore` (already added)

---

### 2. Create Render Account

1. Go to https://render.com
2. Sign up with GitHub
3. Authorize Render to access your repositories

---

### 3. Deploy on Render

#### Option A: Using Blueprint (Recommended)

1. **Go to Render Dashboard**
   - Click "New" → "Blueprint"

2. **Connect Repository**
   - Select your `angel-intraday-bot` repository
   - Render will automatically detect `render.yaml`

3. **Configure Environment Variables**
   - Click on the detected service
   - Go to "Environment" section
   - Add these secrets:

```
TRADING_MODE=PAPER              # Use PAPER for testing, REAL for live
ANGEL_API_KEY=your_api_key
ANGEL_CLIENT_ID=your_client_id
ANGEL_PASSWORD=your_password
ANGEL_TOTP_SECRET=your_totp_secret
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
WATCHLIST=TCS,RELIANCE,INFY    # Comma-separated symbols
MAX_POSITION_SIZE=100000        # Max ₹1 lakh per position
DAILY_LOSS_LIMIT=5000          # Max ₹5k loss per day
MAX_OPEN_POSITIONS=3           # Max 3 concurrent positions
```

4. **Deploy**
   - Click "Apply" or "Create Resources"
   - Render will build and start your bot

---

#### Option B: Manual Setup

1. **Go to Render Dashboard**
   - Click "New" → "Background Worker"

2. **Connect Repository**
   - Connect your GitHub account
   - Select `angel-intraday-bot` repository
   - Branch: `main`

3. **Configure Service**
   ```
   Name: angel-intraday-bot
   Region: Singapore (or closest to you)
   Branch: main
   Runtime: Node
   Build Command: npm install && npm run build
   Start Command: npm start
   ```

4. **Select Plan**
   - **Starter (Free):** Good for testing
     - 512 MB RAM
     - Shared CPU
     - Bot may sleep after inactivity

   - **Standard ($7/month):** Recommended for live trading
     - 2 GB RAM
     - Always on
     - No sleep

5. **Add Environment Variables** (same as Option A)

6. **Deploy**
   - Click "Create Background Worker"

---

### 4. Monitor Deployment

1. **View Logs**
   - Go to your service dashboard
   - Click "Logs" tab
   - You should see:
   ```
   🚀 Trading Engine Started
   Mode: PAPER
   Balance: ₹10,00,000
   ```

2. **Check Telegram**
   - You should receive a startup message
   - Confirms bot is running

3. **Health Checks**
   - Render automatically monitors your service
   - Restarts if it crashes

---

## 🔧 Configuration

### Environment Variables

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `TRADING_MODE` | Trading mode | `PAPER` or `REAL` | ✅ Yes |
| `ANGEL_API_KEY` | Angel One API key | `NEAa1eEt` | ✅ Yes |
| `ANGEL_CLIENT_ID` | Angel One client ID | `A12345` | ✅ Yes |
| `ANGEL_PASSWORD` | Angel One password | `****` | ✅ Yes |
| `ANGEL_TOTP_SECRET` | TOTP secret for 2FA | `I35IKZA...` | ✅ Yes |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | `8519908934:AAH...` | ✅ Yes |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | `123456789` | ✅ Yes |
| `WATCHLIST` | Symbols to trade | `TCS,RELIANCE,INFY` | No (default: empty) |
| `MAX_POSITION_SIZE` | Max position value | `100000` | No (default: 50000) |
| `DAILY_LOSS_LIMIT` | Max daily loss | `5000` | No (default: 10000) |
| `MAX_OPEN_POSITIONS` | Max concurrent positions | `3` | No (default: 5) |
| `NODE_ENV` | Node environment | `production` | Auto-set |

---

## 📊 Monitoring Your Bot

### 1. Render Dashboard

**View Logs:**
- Real-time logs in "Logs" tab
- Filter by log level
- Download logs

**Service Status:**
- Green: Running ✅
- Yellow: Starting 🟡
- Red: Failed ❌

**Metrics:**
- CPU usage
- Memory usage
- Network traffic

### 2. Telegram Notifications

You'll receive notifications for:
- ✅ Bot startup/shutdown
- 🚀 Trade signals (BUY/SELL)
- 📊 Position updates
- 🎯 Target hits
- 🛑 Stop loss triggers
- ⚠️ Errors and alerts

### 3. Logs Location

**On Render:**
- Dashboard → Logs tab
- Real-time streaming
- 7-day history

**Download Logs:**
- Click download icon
- Get full log file

---

## 🔄 Auto-Deploy on Push

**Setup (Already Configured):**
1. Every push to `main` branch triggers auto-deploy
2. Render rebuilds and restarts your bot
3. Zero downtime deployment

**To disable auto-deploy:**
1. Service settings → "Auto-Deploy"
2. Toggle off

---

## ⚙️ Common Issues & Solutions

### Issue 1: Bot Sleeps After Inactivity (Free Plan)

**Problem:** Render free plan spins down after 15 minutes of inactivity

**Solutions:**
1. **Upgrade to Standard plan** ($7/month) - Always on ✅
2. **Keep-alive ping** (not recommended for trading)
3. **Use during market hours only** (9:15 AM - 3:30 PM IST)

---

### Issue 2: Build Failed

**Error:** `npm install` or `npm run build` fails

**Solutions:**
1. Check `package.json` has all dependencies
2. Verify TypeScript compiles locally: `npm run build`
3. Check Render logs for specific error
4. Ensure Node version compatibility (18.x)

---

### Issue 3: Environment Variables Not Set

**Error:** Bot crashes with "Missing configuration"

**Solutions:**
1. Go to service → Environment
2. Add all required variables
3. Click "Save Changes"
4. Manually trigger redeploy

---

### Issue 4: Bot Not Receiving Market Data

**Error:** No signals generated

**Solutions:**
1. Check TRADING_MODE (PAPER or REAL)
2. Verify Angel One API credentials
3. Check market hours (9:15 AM - 3:30 PM IST)
4. Review logs for API errors

---

### Issue 5: Telegram Not Working

**Error:** No messages received

**Solutions:**
1. Verify `TELEGRAM_BOT_TOKEN` is correct
2. Verify `TELEGRAM_CHAT_ID` is correct
3. Test bot locally first
4. Check if bot is blocked

---

## 🔐 Security Best Practices

### 1. Never Commit Secrets

**Already Protected:**
- `.env` in `.gitignore`
- Secrets stored in Render dashboard
- No credentials in code

### 2. Use Environment Variables

**Do:**
```javascript
const apiKey = process.env.ANGEL_API_KEY; // ✅ Good
```

**Don't:**
```javascript
const apiKey = "NEAa1eEt"; // ❌ Bad
```

### 3. Rotate Credentials Regularly

- Change passwords every 3 months
- Regenerate TOTP secret if exposed
- Update tokens on Render dashboard

### 4. Enable 2FA

- Enable 2FA on GitHub
- Enable 2FA on Render
- Enable 2FA on Angel One

---

## 💰 Pricing

### Free Plan (Starter)
- ✅ Good for testing
- ✅ 512 MB RAM
- ❌ Spins down after 15 min inactivity
- ❌ Not suitable for live trading

### Standard Plan ($7/month)
- ✅ Always on (no sleep)
- ✅ 2 GB RAM
- ✅ Shared CPU
- ✅ Recommended for live trading

### Pro Plan ($25/month)
- ✅ Always on
- ✅ 4 GB RAM
- ✅ Dedicated CPU
- ✅ Priority support

**Recommendation:** Start with Standard plan for live trading

---

## 🛠️ Maintenance

### Update Code

```bash
# Make changes locally
git add .
git commit -m "Update strategy"
git push

# Render auto-deploys (if enabled)
# Or manually deploy from dashboard
```

### View Deployment History

1. Service dashboard → "Events"
2. See all deployments
3. Rollback if needed

### Rollback to Previous Version

1. Service → "Manual Deploy"
2. Select previous commit
3. Click "Deploy"

---

## 📞 Support

### Render Support
- Docs: https://render.com/docs
- Community: https://community.render.com
- Status: https://status.render.com

### Bot Issues
- Check logs first
- Review error messages
- Test locally in PAPER mode
- Verify all environment variables

---

## ✅ Deployment Checklist

Before going live:

- [ ] Code pushed to GitHub
- [ ] `.env` is in `.gitignore`
- [ ] Render service created
- [ ] All environment variables set
- [ ] Build successful
- [ ] Bot started (check logs)
- [ ] Telegram notifications working
- [ ] Test in PAPER mode first (minimum 30 days)
- [ ] Verify strategy logic
- [ ] Monitor for 1 week before going REAL
- [ ] Set appropriate position limits
- [ ] Set daily loss limit
- [ ] Upgrade to Standard plan for live trading

---

## 🎯 Next Steps

1. **Deploy to Render** (follow steps above)
2. **Test in PAPER mode** (minimum 30 days)
3. **Monitor performance** (daily review)
4. **Adjust parameters** (based on results)
5. **Go live carefully** (start small)
6. **Scale gradually** (only if profitable)

---

## 🚨 Important Warnings

1. **Test Thoroughly:** Use PAPER mode for at least 30 days
2. **Start Small:** Use minimum position sizes initially
3. **Monitor Closely:** Review trades daily
4. **Risk Management:** Never risk more than you can afford to lose
5. **No Guarantees:** Past performance doesn't guarantee future results
6. **Compliance:** Ensure your trading complies with regulations
7. **Backup:** Keep local backups of configuration

---

## 🎉 You're Ready!

Your trading bot is now deployed on Render and ready to trade!

**Remember:**
- Start in PAPER mode
- Monitor closely
- Test thoroughly
- Trade responsibly

Good luck! 🚀
