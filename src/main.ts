import { TradingEngine } from './core/tradingEngine';
import { DayHighLowBreakoutStrategy } from './strategies/dayHighLowBreakout';
import configManager from './config';
import { logger } from './utils/logger';
import { healthCheckServer } from './utils/healthCheck';

async function main() {
  try {
    logger.info('Initializing Angel Intraday Trading Bot');
    logger.info('='.repeat(50));

    // Start health check server for Render.com
    healthCheckServer.start();
    healthCheckServer.updateStatus(true, false);

    const config = configManager.getConfig();

    logger.info('Configuration loaded', {
      mode: config.trading.mode,
      killSwitch: config.trading.killSwitch,
      autoSquareOffTime: config.trading.autoSquareOffTime,
      marginEnabled: config.trading.riskLimits.useMargin,
      marginMultiplier: config.trading.riskLimits.marginMultiplier
    });

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

    const engine = new TradingEngine(config, watchlist);

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
        // Mark health check as unhealthy
        healthCheckServer.setUnhealthy();

        await engine.stop();
        logger.info('Trading engine stopped successfully');

        // Stop health check server
        await healthCheckServer.stop();

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
      logger.error('Unhandled Rejection at:', { reason, promise });
      // Don't crash on unhandled rejections - log and continue
      // Most are recoverable errors (API timeouts, network issues, etc.)

      // Track unhandled rejections to prevent memory leaks
      const errorMessage = reason instanceof Error ? reason.message : String(reason);
      if (errorMessage.includes('FATAL') || errorMessage.includes('EMFILE')) {
        logger.error('Fatal unhandled rejection detected - initiating shutdown');
        shutdown('UNHANDLED_REJECTION');
      }
    });

    process.on('uncaughtException', async (error) => {
      logger.error('Uncaught Exception', error);

      // Only shutdown for critical errors, not recoverable ones
      const errorMessage = error.message || '';
      const isCritical = errorMessage.includes('EADDRINUSE') ||
                        errorMessage.includes('ENOSPC') ||
                        errorMessage.includes('EMFILE') ||
                        errorMessage.includes('Out of memory');

      if (isCritical && !isShuttingDown) {
        logger.error('Critical error detected - initiating shutdown');
        await shutdown('UNCAUGHT_EXCEPTION');
        process.exit(1);
      } else {
        logger.warn('Non-critical exception - continuing operation');
        // Continue running for recoverable errors
      }
    });

    // Handle process warnings (memory leaks, etc.)
    process.on('warning', (warning) => {
      logger.warn('Process warning', {
        name: warning.name,
        message: warning.message,
        stack: warning.stack
      });

      // Alert on MaxListenersExceededWarning (potential memory leak)
      if (warning.name === 'MaxListenersExceededWarning') {
        logger.error('MEMORY LEAK WARNING: Too many event listeners detected');
      }
    });

    await engine.start();

    // Update health check - engine is running
    healthCheckServer.setEngineRunning(true);

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
