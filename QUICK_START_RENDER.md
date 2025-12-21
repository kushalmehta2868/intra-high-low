# Quick Start: Deploy to Render in 5 Minutes

## 🚀 Fastest Way to Deploy

### 1. Push to GitHub (2 minutes)

```bash
# Make sure .env is NOT committed
git status

# Add and commit
git add .
git commit -m "Ready for Render deployment"

# Create repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/angel-intraday-bot.git
git push -u origin main
```

### 2. Deploy on Render (3 minutes)

**Visit:** https://render.com

1. **Sign Up** with GitHub
2. Click **"New +"** → **"Blueprint"**
3. **Connect** your `angel-intraday-bot` repository
4. **Add Environment Variables:**
   ```
   TRADING_MODE=PAPER
   ANGEL_API_KEY=your_key
   ANGEL_CLIENT_ID=your_id
   ANGEL_PASSWORD=your_pass
   ANGEL_TOTP_SECRET=your_totp
   TELEGRAM_BOT_TOKEN=your_token
   TELEGRAM_CHAT_ID=your_chat_id
   ```
5. Click **"Apply"**

**Done!** Your bot is deploying.

---

## ✅ Verify Deployment

### Check Logs (30 seconds later)

You should see:
```
🚀 Trading Engine Started
Mode: PAPER
Balance: ₹10,00,000
✅ Position reconciliation: Active
✅ Stop-loss monitoring: Active
✅ Performance tracking: Active
```

### Check Telegram

You should receive:
```
🚀 Trading Engine Started

Mode: PAPER
Balance: ₹10,00,000

✅ Position reconciliation: Active
✅ Stop-loss monitoring: Active
✅ Performance tracking: Active
```

---

## 📊 Monitor Your Bot

**Render Dashboard:**
- https://dashboard.render.com
- Select your service
- View logs in real-time

**Telegram:**
- Receive all trade notifications
- Get alerts for errors
- Monitor performance

---

## 🔧 Common Environment Variables

### Required (Must Set)
```bash
TRADING_MODE=PAPER              # Start with PAPER mode
ANGEL_API_KEY=your_api_key
ANGEL_CLIENT_ID=your_client_id
ANGEL_PASSWORD=your_password
ANGEL_TOTP_SECRET=your_totp_secret
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### Optional (With Defaults)
```bash
WATCHLIST=TCS,RELIANCE,INFY    # Default: empty
MAX_POSITION_SIZE=100000        # Default: 50000
DAILY_LOSS_LIMIT=5000          # Default: 10000
MAX_OPEN_POSITIONS=3           # Default: 5
```

---

## 💡 Tips

### Free vs Paid Plan

**Free Plan (Starter):**
- ✅ Good for testing
- ❌ Sleeps after 15 min inactivity
- ❌ **Not suitable for live trading**

**Standard Plan ($7/month):**
- ✅ Always on
- ✅ No sleep
- ✅ **Recommended for live trading**

### Auto-Deploy

Every `git push` triggers automatic deployment:
```bash
git add .
git commit -m "Update strategy"
git push  # Auto-deploys!
```

### View Logs

```bash
# In Render dashboard:
Service → Logs → Real-time logs
```

---

## 🎯 Next Steps

1. ✅ Deploy (5 minutes) - **Done!**
2. 📊 Monitor in PAPER mode (30 days minimum)
3. 📈 Review performance daily
4. 🚀 Go live (only if profitable)

---

## 🚨 Before Going LIVE

- [ ] Tested in PAPER mode for 30+ days
- [ ] Win rate > 67% (with 1:0.5 RR)
- [ ] Max drawdown < 10%
- [ ] Upgraded to Standard plan ($7/mo)
- [ ] Set conservative position limits
- [ ] Set daily loss limit
- [ ] Telegram notifications working
- [ ] Monitored for errors/issues

---

## 📞 Need Help?

- **Render Docs:** https://render.com/docs
- **Render Status:** https://status.render.com
- **Render Community:** https://community.render.com

---

**You're all set! Happy trading! 🎉**
