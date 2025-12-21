# 📋 Deployment Checklist

Complete checklist before deploying to Render.

---

## ✅ Pre-Deployment Checklist

### 1. Code Ready
- [ ] All TypeScript code compiles: `npm run build`
- [ ] No errors in console
- [ ] Strategy tested locally
- [ ] All services integrated

### 2. Configuration Files
- [ ] `render.yaml` exists
- [ ] `Dockerfile` exists
- [ ] `.dockerignore` exists
- [ ] `.gitignore` includes `.env`
- [ ] `.env.example` has placeholder values (no real credentials)

### 3. Git Repository
- [ ] Code committed to Git
- [ ] `.env` NOT committed (check with `git status`)
- [ ] Pushed to GitHub
- [ ] Repository is accessible

### 4. Credentials Ready
- [ ] Angel One API key
- [ ] Angel One client ID
- [ ] Angel One password
- [ ] Angel One TOTP secret
- [ ] Telegram bot token
- [ ] Telegram chat ID

---

## 🚀 Deployment Steps

### Step 1: GitHub Push
```bash
# Verify .env is ignored
git status

# Should NOT show .env in the list
# If it does, add to .gitignore first

# Add files
git add .

# Commit
git commit -m "Ready for Render deployment"

# Push
git push origin main
```
- [ ] Code pushed to GitHub
- [ ] No secrets committed

### Step 2: Render Account
- [ ] Created account at https://render.com
- [ ] Signed up with GitHub
- [ ] Authorized Render to access repos

### Step 3: Create Service
- [ ] Clicked "New +" → "Blueprint"
- [ ] Selected `angel-intraday-bot` repo
- [ ] Blueprint detected `render.yaml`

### Step 4: Environment Variables
Add these in Render dashboard:

```bash
# Trading Mode
- [ ] TRADING_MODE=PAPER

# Angel One API
- [ ] ANGEL_API_KEY=your_actual_key
- [ ] ANGEL_CLIENT_ID=your_actual_id
- [ ] ANGEL_PASSWORD=your_actual_password
- [ ] ANGEL_TOTP_SECRET=your_actual_totp

# Telegram
- [ ] TELEGRAM_BOT_TOKEN=your_actual_token
- [ ] TELEGRAM_CHAT_ID=your_actual_chat_id

# Trading Params (Optional)
- [ ] WATCHLIST=TCS,RELIANCE,INFY
- [ ] MAX_POSITION_SIZE=100000
- [ ] DAILY_LOSS_LIMIT=5000
- [ ] MAX_OPEN_POSITIONS=3
```

### Step 5: Deploy
- [ ] Clicked "Apply" or "Create Resources"
- [ ] Build started
- [ ] Build completed successfully
- [ ] Service is running

---

## ✅ Post-Deployment Verification

### 1. Check Build Logs (Immediately)
```
Expected output:
✓ npm install
✓ npm run build
✓ TypeScript compiled successfully
✓ Service starting...
```
- [ ] No build errors
- [ ] Dependencies installed
- [ ] TypeScript compiled

### 2. Check Runtime Logs (30 seconds later)
```
Expected output:
🚀 Trading Engine Started
Mode: PAPER
Balance: ₹10,00,000
✅ Position reconciliation: Active
✅ Stop-loss monitoring: Active
✅ Performance tracking: Active
```
- [ ] Bot started successfully
- [ ] No runtime errors
- [ ] Services initialized

### 3. Check Telegram (1 minute later)
- [ ] Received startup message
- [ ] Bot is responsive
- [ ] No error messages

### 4. Monitor for 5 Minutes
- [ ] Bot stays running (doesn't crash)
- [ ] Logs show periodic updates
- [ ] No error messages

### 5. Test During Market Hours
- [ ] Bot activates at market open (9:15 AM IST)
- [ ] Receives market data
- [ ] Logs price updates
- [ ] Strategy is active

---

## 🔧 Configuration Verification

### Environment Check
```bash
# In Render dashboard → Service → Environment

Verify all variables are set:
✓ TRADING_MODE
✓ ANGEL_API_KEY
✓ ANGEL_CLIENT_ID
✓ ANGEL_PASSWORD
✓ ANGEL_TOTP_SECRET
✓ TELEGRAM_BOT_TOKEN
✓ TELEGRAM_CHAT_ID
```

### Service Settings
```bash
# In Render dashboard → Service → Settings

✓ Name: angel-intraday-bot
✓ Region: Singapore (or nearest)
✓ Plan: Starter (free) or Standard ($7/mo)
✓ Branch: main
✓ Auto-Deploy: Enabled
```

---

## 📊 Monitoring Setup

### 1. Render Dashboard
- [ ] Bookmarked service URL
- [ ] Logs tab accessible
- [ ] Events tab showing deployments

### 2. Telegram
- [ ] Bot chat opened
- [ ] Notifications enabled
- [ ] Test message sent

### 3. Set Alerts (Optional)
- [ ] Email notifications for deployment failures
- [ ] Telegram alerts for critical errors

---

## 🚨 Troubleshooting

### Build Fails

**Check:**
- [ ] `package.json` has all dependencies
- [ ] `tsconfig.json` is valid
- [ ] Code compiles locally: `npm run build`

**Fix:**
```bash
# Locally test build
npm install
npm run build

# If successful, push again
git add .
git commit -m "Fix build issues"
git push
```

### Service Crashes

**Check:**
- [ ] Logs show the error
- [ ] Environment variables are set
- [ ] No missing dependencies

**Fix:**
- Review error message
- Fix code locally
- Push update

### No Telegram Messages

**Check:**
- [ ] `TELEGRAM_BOT_TOKEN` is correct
- [ ] `TELEGRAM_CHAT_ID` is correct
- [ ] Bot started successfully (check logs)

**Fix:**
- Verify token with BotFather
- Get chat ID: send `/start` to bot
- Update environment variables

---

## 💰 Cost Estimation

### Free Plan (Starter)
```
Cost: $0/month
RAM: 512 MB
Features: Basic, sleeps after 15 min
Suitable for: Testing only
```

### Standard Plan
```
Cost: $7/month
RAM: 2 GB
Features: Always on, no sleep
Suitable for: Live trading
```

**Recommendation:** Standard plan for live trading

---

## 🎯 Go-Live Checklist

Before switching to REAL mode:

### Testing Complete
- [ ] Ran in PAPER mode for 30+ days
- [ ] Win rate > 67% (with 1:0.5 RR)
- [ ] Max drawdown < 10%
- [ ] No critical bugs
- [ ] Strategy performs as expected

### Infrastructure Ready
- [ ] Upgraded to Standard plan ($7/mo)
- [ ] Service never crashed
- [ ] Logs are clean
- [ ] Telegram alerts working
- [ ] Position reconciliation working
- [ ] Stop-loss manager working

### Risk Management Set
- [ ] `MAX_POSITION_SIZE` appropriate
- [ ] `DAILY_LOSS_LIMIT` set conservatively
- [ ] `MAX_OPEN_POSITIONS` limited
- [ ] Starting with small capital
- [ ] Emergency stop plan ready

### Monitoring Ready
- [ ] Render dashboard bookmarked
- [ ] Telegram notifications on
- [ ] Daily review schedule set
- [ ] Performance tracking active

### Final Checks
- [ ] All credentials rotated (security)
- [ ] 2FA enabled everywhere
- [ ] Backup of configuration
- [ ] Team/partner informed (if applicable)
- [ ] Trading plan documented

---

## 🎉 You're Ready!

Once all items are checked:

1. **Deploy:** Push to GitHub → Auto-deploy to Render
2. **Monitor:** Watch logs for 24 hours
3. **Test:** Verify in PAPER mode first
4. **Go Live:** Switch to REAL mode carefully
5. **Scale:** Increase position sizes gradually

---

## 📞 Support Resources

- **Render Docs:** https://render.com/docs
- **Render Status:** https://status.render.com
- **Render Community:** https://community.render.com
- **This Bot's Docs:**
  - [RENDER_DEPLOYMENT.md](RENDER_DEPLOYMENT.md) - Full guide
  - [QUICK_START_RENDER.md](QUICK_START_RENDER.md) - 5-minute setup
  - [STRATEGY_IMPLEMENTATION.md](STRATEGY_IMPLEMENTATION.md) - Strategy details

---

**Happy Trading! 🚀**
