import { TradingEngine } from './core/tradingEngine';
import { DayHighLowBreakoutStrategy } from './strategies/dayHighLowBreakout';
import configManager from './config';
import { logger } from './utils/logger';

async function main() {
  try {
    logger.info('Initializing Angel Intraday Trading Bot');
    logger.info('='.repeat(50));

    const config = configManager.getConfig();

    logger.info('Configuration loaded', {
      mode: config.trading.mode,
      killSwitch: config.trading.killSwitch,
      autoSquareOffTime: config.trading.autoSquareOffTime,
      marginEnabled: config.trading.riskLimits.useMargin,
      marginMultiplier: config.trading.riskLimits.marginMultiplier
    });

    const engine = new TradingEngine(config);

    const watchlist = [
      'RELIANCE-EQ',
      'TCS-EQ',
      'INFY-EQ',
      'HDFCBANK-EQ',
      'ICICIBANK-EQ',
      'TRENT-EQ',
      'ULTRACEMCO-EQ',
      'MUTHOOTFIN-EQ',
      'COFORGE-EQ',
      'ABB-EQ',
      'ALKEM-EQ',
      'AMBER-EQ',
      'ANGELONE-EQ',
      'APOLLOHOSP-EQ',
      'BAJAJ-AUTO-EQ',
      'BHARTIARTL-EQ',
      'BRITANNIA-EQ',
      'BSE-EQ',
      'CUMMINSIND-EQ',
      'DIXON-EQ',
      'GRASIM-EQ',
      'HAL-EQ',
      'HDFCAMC-EQ',
      'HEROMOTOCO-EQ',
    ];

    const initialBalance = 1000000;
    const marginMultiplier = config.trading.riskLimits.marginMultiplier;

    const strategy = new DayHighLowBreakoutStrategy(
      {
        marketData: new Map(),
        positions: new Map(),
        accountInfo: {
          balance: initialBalance,
          availableMargin: initialBalance,
          usedMargin: 0,
          realizedPnL: 0,
          unrealizedPnL: 0,
          marginMultiplier: marginMultiplier,
          effectiveBuyingPower: initialBalance * marginMultiplier
        },
        config: config.trading
      },
      watchlist
    );

    engine.addStrategy(strategy);

    logger.info('Strategy initialized', {
      name: strategy.getName(),
      watchlist,
      initialBalance: initialBalance,
      marginMultiplier: marginMultiplier,
      effectiveBuyingPower: initialBalance * marginMultiplier
    });

    // Flag to prevent multiple shutdown attempts
    let isShuttingDown = false;

    const shutdown = async (signal: string) => {
      if (isShuttingDown) {
        logger.warn('Shutdown already in progress...');
        return;
      }

      isShuttingDown = true;
      logger.info(`Received ${signal}, shutting down gracefully...`);

      try {
        await engine.stop();
        logger.info('Trading engine stopped successfully');

        // Give a moment for cleanup
        setTimeout(() => {
          logger.info('Shutdown complete. Exiting...');
          process.exit(0);
        }, 1000);
      } catch (error: any) {
        logger.error('Error during shutdown', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection', { reason, promise });
    });

    process.on('uncaughtException', async (error) => {
      logger.error('Uncaught Exception', error);
      if (!isShuttingDown) {
        await shutdown('UNCAUGHT_EXCEPTION');
      }
      process.exit(1);
    });

    await engine.start();

    logger.info('='.repeat(50));
    logger.info('Trading Bot is now running');
    logger.info('Press Ctrl+C to stop');
    logger.info('='.repeat(50));

  } catch (error: any) {
    logger.error('Fatal error during startup', error);
    process.exit(1);
  }
}

main();
