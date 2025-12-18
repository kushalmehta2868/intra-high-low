# Angel One Intraday Trading Bot

A production-grade, event-driven intraday trading system for Indian stock markets using Angel One SmartAPI.

## Features

### Trading Modes
- **PAPER Mode**: Simulated execution with live market data (no real trades)
- **REAL Mode**: Live trading with actual broker execution
- Same strategy and risk logic across both modes
- Seamless mode switching via configuration

### Risk Management (Mandatory)
- Maximum risk per trade (% of capital)
- Maximum trades per day limit
- Maximum daily loss limit (% of capital)
- Position sizing based on stop-loss
- Kill switch (config + Telegram control)
- Real-time risk monitoring and alerts

### Strategy Framework
- Plugin-based architecture
- Swappable strategy implementations
- Event-driven signal generation
- **Day High/Low Breakout Strategy** (included as example)

### Automation
- Auto square-off before market close (15:20 default)
- Market hours scheduling
- Intraday only (no overnight positions)
- Automatic daily reset

### Telegram Bot Integration
- Real-time trade notifications
- Position updates
- P&L tracking
- Risk statistics
- Emergency kill switch
- Status monitoring commands

### Production-Ready
- Modular and event-driven architecture
- Comprehensive audit logging
- Error handling and recovery
- Type-safe TypeScript codebase
- No hard-coded credentials
- Graceful shutdown handling

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Trading Engine                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Scheduler  │  │ Risk Manager │  │ Position Mgr │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
   ┌────▼────┐       ┌──────▼──────┐     ┌─────▼─────┐
   │Strategy │       │   Broker    │     │ Telegram  │
   │ Engine  │       │ Abstraction │     │    Bot    │
   └─────────┘       └──────┬──────┘     └───────────┘
                            │
                ┌───────────┴───────────┐
                │                       │
          ┌─────▼─────┐          ┌──────▼──────┐
          │ AngelOne  │          │   Paper     │
          │  Broker   │          │   Broker    │
          └───────────┘          └─────────────┘
```

## Installation

### Prerequisites
- Node.js (v18 or higher)
- npm or yarn
- Angel One trading account (for REAL mode)
- Telegram Bot Token and Chat ID

### Setup

1. **Clone the repository**
```bash
git clone <your-repo-url>
cd angel-intraday-bot
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment**
```bash
cp .env.example .env
```

Edit `.env` file with your credentials:

```env
# Trading Mode: PAPER or REAL
TRADING_MODE=PAPER

# Angel One API Credentials (required for REAL mode)
ANGEL_API_KEY=your_api_key_here
ANGEL_CLIENT_ID=your_client_id_here
ANGEL_PASSWORD=your_password_here
ANGEL_TOTP_SECRET=your_totp_secret_here

# Telegram Bot Configuration (required)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here

# Risk Management Settings
MAX_RISK_PER_TRADE_PERCENT=2
MAX_TRADES_PER_DAY=5
MAX_DAILY_LOSS_PERCENT=5
POSITION_SIZE_PERCENT=10

# Trading Configuration
AUTO_SQUARE_OFF_TIME=15:20
MARKET_START_TIME=09:15
MARKET_END_TIME=15:30

# Logging
LOG_LEVEL=info
ENABLE_AUDIT_LOG=true

# Kill Switch (set to true to disable all trading)
KILL_SWITCH=false
```

### Getting Angel One API Credentials

1. Login to Angel One SmartAPI portal
2. Create an API app to get API Key and Client ID
3. Enable TOTP for your account
4. Generate TOTP secret from your authenticator app

### Setting up Telegram Bot

1. Create a bot via [@BotFather](https://t.me/botfather)
2. Get your Bot Token
3. Start a chat with your bot
4. Get your Chat ID from [@userinfobot](https://t.me/userinfobot)

## Usage

### Development Mode (with auto-reload)
```bash
npm run dev
```

### Build
```bash
npm run build
```

### Production Mode
```bash
npm start
```

## Telegram Commands

Once the bot is running, use these commands in Telegram:

- `/start` - Initialize bot
- `/status` - Show bot status and current mode
- `/positions` - List all open positions
- `/pnl` - Show P&L summary
- `/risk` - Show risk statistics
- `/killswitch` - Toggle emergency kill switch
- `/help` - Show help message

## Risk Management

The system enforces mandatory risk controls:

### Pre-Trade Checks
- Order size validation against position size limit
- Daily trade count check
- Daily loss limit verification
- Risk per trade calculation based on stop-loss

### Real-Time Monitoring
- Position-level stop-loss tracking
- Target price monitoring
- Daily P&L tracking
- Automatic alerts at 80% of limits

### Circuit Breakers
- Kill switch (manual or automatic)
- Daily loss limit auto-shutdown
- Max trades per day enforcement
- After-hours trading prevention

## Strategy Development

### Creating a Custom Strategy

1. Extend the `BaseStrategy` class:

```typescript
import { BaseStrategy } from './strategies/base';
import { StrategyContext, MarketData, StrategySignal } from './types';

export class MyStrategy extends BaseStrategy {
  constructor(context: StrategyContext) {
    super('MyStrategy', context);
  }

  public async initialize(): Promise<void> {
    await super.initialize();
    // Your initialization logic
  }

  public onMarketData(data: MarketData): void {
    // Your strategy logic

    // Generate signals
    const signal: StrategySignal = {
      symbol: data.symbol,
      action: 'BUY',
      stopLoss: data.ltp * 0.98,
      target: data.ltp * 1.04,
      reason: 'My strategy condition met'
    };

    this.emitSignal(signal);
  }
}
```

2. Register strategy in [src/main.ts](src/main.ts):

```typescript
const myStrategy = new MyStrategy(context, watchlist);
engine.addStrategy(myStrategy);
```

## Paper Trading vs Real Trading

### Paper Trading (TRADING_MODE=PAPER)
- Simulated order execution
- No real money at risk
- Perfect for testing strategies
- 1M virtual capital by default
- Realistic slippage simulation
- Complete audit trail

### Real Trading (TRADING_MODE=REAL)
- Live order execution via Angel One
- Real money at risk
- Requires valid API credentials
- All risk controls enforced
- Full audit logging
- Production-ready

## Logging and Audit

### Application Logs
Located in `logs/` directory:
- `app-YYYY-MM-DD.log` - Daily application logs
- Configurable log levels: debug, info, warn, error

### Audit Logs
Located in `audit/` directory:
- `audit-YYYY-MM-DD.jsonl` - Daily audit trail in JSONL format
- Records all trading events:
  - Login/logout
  - Orders placed/cancelled
  - Positions opened/closed
  - Risk limit breaches
  - Strategy signals
  - Configuration changes

## Safety Features

### Built-in Safeguards
- ✅ No trading outside market hours (9:15 AM - 3:30 PM)
- ✅ No trading on weekends
- ✅ Automatic square-off before market close
- ✅ Position-level stop-loss enforcement
- ✅ Maximum daily loss protection
- ✅ Trade count limits
- ✅ Kill switch for emergency shutdown
- ✅ Graceful shutdown on errors
- ✅ No overnight positions

### What This System Does NOT Do
- ❌ Guarantee returns
- ❌ Claim accuracy percentages
- ❌ Promise specific profits
- ❌ Auto-tune parameters
- ❌ Trade without risk management

## File Structure

```
angel-intraday-bot/
├── src/
│   ├── brokers/
│   │   ├── base.ts                 # Broker abstraction
│   │   ├── angelone/
│   │   │   ├── client.ts           # Angel One API client
│   │   │   └── broker.ts           # Angel One broker implementation
│   │   └── paper/
│   │       └── broker.ts           # Paper trading simulator
│   ├── config/
│   │   └── index.ts                # Configuration management
│   ├── core/
│   │   ├── positionManager.ts      # Position tracking
│   │   ├── scheduler.ts            # Market hours scheduling
│   │   └── tradingEngine.ts        # Main orchestrator
│   ├── risk/
│   │   └── riskManager.ts          # Risk management engine
│   ├── strategies/
│   │   ├── base.ts                 # Strategy interface
│   │   └── dayHighLowBreakout.ts   # Example strategy
│   ├── telegram/
│   │   └── bot.ts                  # Telegram bot
│   ├── types/
│   │   └── index.ts                # TypeScript types
│   ├── utils/
│   │   └── logger.ts               # Logging utility
│   └── main.ts                     # Entry point
├── .env.example                     # Environment template
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

### Common Issues

**1. "Configuration validation failed"**
- Check all required environment variables in `.env`
- Verify TOTP secret format
- Ensure time format is HH:MM

**2. "Failed to connect to broker"**
- Verify Angel One credentials
- Check API key permissions
- Ensure TOTP is enabled on account

**3. "Telegram bot not responding"**
- Verify bot token is correct
- Check chat ID matches your account
- Ensure bot is not blocked

**4. "Orders not executing"**
- Check if kill switch is active (`/killswitch`)
- Verify market hours
- Check risk limits haven't been breached
- Review logs for specific errors

## Development

### Running Tests
```bash
npm test
```

### Type Checking
```bash
npm run build
```

### Code Formatting
```bash
npm run format
```

## Important Disclaimers

⚠️ **Trading Risks**
- Trading in stock markets involves risk
- Past performance does not guarantee future results
- This is educational software, not financial advice
- Test thoroughly in PAPER mode before using REAL mode
- Start with small position sizes
- Never risk more than you can afford to lose

⚠️ **No Guarantees**
- This system does not guarantee profits
- Strategy performance varies with market conditions
- Risk management reduces but does not eliminate losses
- Always monitor your positions actively

⚠️ **Use at Your Own Risk**
- You are solely responsible for all trading decisions
- Review and understand the code before use
- Ensure compliance with local regulations
- The authors assume no liability for losses

## License

ISC

## Support

For issues and questions:
- Check the logs in `logs/` and `audit/` directories
- Review configuration in `.env`
- Consult Angel One API documentation
- Verify Telegram bot setup

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

---

**Remember**: Always start with PAPER trading mode to test your strategies and configuration before switching to REAL mode.
