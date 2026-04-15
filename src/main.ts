import { TradingEngine } from './core/tradingEngine';
import { DayHighLowBreakoutStrategy } from './strategies/dayHighLowBreakout';
import { EngulfingPatternStrategy } from './strategies/engulfingPattern';
import { EMACrossoverStrategy } from './strategies/emaCrossover';
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

    // NIFTY 50 constituents only (Angel One NSE-EQ format)
    const watchlist = [
      'RELIANCE-EQ',
      'TCS-EQ',
      'INFY-EQ',
      'HDFCBANK-EQ',
      'ICICIBANK-EQ',
      'BHARTIARTL-EQ',
      'SBIN-EQ',
      'KOTAKBANK-EQ',
      'WIPRO-EQ',
      'HCLTECH-EQ',
      'BAJFINANCE-EQ',
      'AXISBANK-EQ',
      'ASIANPAINT-EQ',
      'MARUTI-EQ',
      'ULTRACEMCO-EQ',
      'BAJAJFINSV-EQ',
      'TITAN-EQ',
      'HINDUNILVR-EQ',
      'NTPC-EQ',
      'SUNPHARMA-EQ',
      'TATAMOTORS-EQ',
      'TECHM-EQ',
      'ITC-EQ',
      'LT-EQ',
    ];

    const engine = new TradingEngine(config, watchlist);

    const initialBalance = 1000000;
    const marginMultiplier = config.trading.riskLimits.marginMultiplier;

    const strategyContext = {
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
    };

    // Strategy 1: Day High/Low Breakout (tick-based)
    const strategy = new DayHighLowBreakoutStrategy(strategyContext, watchlist);
    engine.addStrategy(strategy);

    // Strategy 2: Engulfing Pattern (15-min candle + 1H trend filter)
    const engulfingStrategy = new EngulfingPatternStrategy(strategyContext, watchlist);
    engine.addStrategy(engulfingStrategy);

    // Strategy 3: EMA 9/21 Crossover (15-min candle + 1H trend filter)
    const emaCrossoverStrategy = new EMACrossoverStrategy(strategyContext, watchlist);
    engine.addStrategy(emaCrossoverStrategy);

    logger.info('All strategies registered', {
      strategies: [
        strategy.getName(),
        engulfingStrategy.getName(),
        emaCrossoverStrategy.getName(),
      ],
      watchlist: watchlist.length,
      initialBalance,
      marginMultiplier,
      effectiveBuyingPower: initialBalance * marginMultiplier,
      signalArbiterWindow: '15 seconds',
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

      // CRITICAL FIX: Don't call process.exit() to prevent Render restarts
      // Log the error and attempt recovery instead
      const errorMessage = error.message || '';
      const isCritical = errorMessage.includes('EADDRINUSE') ||
        errorMessage.includes('ENOSPC') ||
        errorMessage.includes('EMFILE') ||
        errorMessage.includes('Out of memory');

      if (isCritical && !isShuttingDown) {
        logger.error('🚨 Critical error detected - attempting graceful recovery', {
          error: errorMessage,
          willRestart: false
        });

        // Mark health check as unhealthy but don't exit
        healthCheckServer.setUnhealthy();

        // Try to recover by stopping and restarting the engine
        try {
          await engine.stop();
          logger.info('Engine stopped after critical error');

          // Wait a bit before attempting restart
          setTimeout(async () => {
            try {
              logger.info('Attempting to restart engine after critical error...');
              await engine.start();
              healthCheckServer.setHealthy();
              logger.info('✅ Engine restarted successfully');
            } catch (restartError: any) {
              logger.error('Failed to restart engine', restartError);
              // Still don't exit - keep health check server alive
            }
          }, 5000);
        } catch (stopError: any) {
          logger.error('Failed to stop engine during recovery', stopError);
        }
      } else {
        logger.warn('Non-critical exception - continuing operation', {
          error: errorMessage
        });
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

    // CRITICAL: Add periodic memory monitoring to detect leaks
    const memoryMonitorInterval = setInterval(() => {
      const usage = process.memoryUsage();
      const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
      const rssMB = Math.round(usage.rss / 1024 / 1024);

      // Log every 5 minutes
      logger.debug('Memory usage', {
        heapUsed: `${heapUsedMB}MB`,
        heapTotal: `${heapTotalMB}MB`,
        rss: `${rssMB}MB`
      });

      // Warn if heap used exceeds 400MB (approaching 512MB limit)
      if (heapUsedMB > 400) {
        logger.warn('⚠️ High memory usage detected', {
          heapUsed: `${heapUsedMB}MB`,
          heapTotal: `${heapTotalMB}MB`,
          threshold: '400MB',
          action: 'Consider restarting if memory continues to grow'
        });
      }

      // Critical if exceeds 450MB (danger zone)
      if (heapUsedMB > 450) {
        logger.error('🚨 CRITICAL MEMORY USAGE', {
          heapUsed: `${heapUsedMB}MB`,
          limit: '512MB',
          action: 'Memory leak suspected - forcing garbage collection'
        });

        // Force garbage collection if available
        if (global.gc) {
          logger.info('Running garbage collection...');
          global.gc();
          const afterGC = process.memoryUsage();
          const afterMB = Math.round(afterGC.heapUsed / 1024 / 1024);
          logger.info('Garbage collection complete', {
            before: `${heapUsedMB}MB`,
            after: `${afterMB}MB`,
            freed: `${heapUsedMB - afterMB}MB`
          });
        }
      }
    }, 5 * 60 * 1000); // Every 5 minutes

    // Don't let interval keep process alive
    memoryMonitorInterval.unref();

    // CRITICAL: Add keep-alive ping to prevent Render from thinking process is dead
    const keepAliveInterval = setInterval(() => {
      logger.debug('Keep-alive ping', {
        uptime: Math.floor(process.uptime()),
        memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
      });
    }, 60 * 1000); // Every 1 minute

    // Don't let interval keep process alive
    keepAliveInterval.unref();

    await engine.start();

    // ✅ CRITICAL: Check if restarting late in day with open positions
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const currentHour = istTime.getHours();

    if (currentHour >= 15) {
      logger.warn('🚨 Bot starting after 3:00 PM - checking for open positions');

      const positions = engine.getOpenPositions();

      if (positions.length > 0) {
        logger.error('🚨 OPEN POSITIONS DETECTED AFTER 3:00 PM', {
          count: positions.length,
          symbols: positions.map(p => p.symbol)
        });

        // Use telegram bot from engine (indirectly via public method or we can expose it)
        // Since we can't access telegramBot directly, we'll use engine to close positions
        // Engine's closeAllPositions sends alerts internally

        logger.info('Initiating emergency square-off due to late restart...');
        await engine.closeAllPositions('Emergency square-off on late restart');
        await engine.verifyAllPositionsClosed();

        // Don't restart strategies
        logger.info('Emergency square-off complete. Not restarting strategies to prevent new trades.');
        // We let the process run to monitor, but strategies are effectively stopped if we closed everything
        // Actually closeAllPositions doesn't stop strategies, so we should explicitly stop them
        await engine.stop();

        // But we want to keep health check alive
        logger.info('Engine stopped after emergency cleanup. Bot is effectively idle.');
      }
    }

    // Update health check - engine is running
    healthCheckServer.setEngineRunning(true);

    logger.info('='.repeat(50));
    logger.info('Trading Bot is now running');
    logger.info('Press Ctrl+C to stop');
    logger.info('='.repeat(50));

  } catch (error: any) {
    logger.error('Fatal error during startup', error);

    // CRITICAL FIX: Don't exit on startup error - keep process alive for Render
    // Start health check in unhealthy state and retry later
    healthCheckServer.start();
    healthCheckServer.setUnhealthy();

    logger.error('🚨 Bot failed to start - health check server running in error state');
    logger.info('Process will remain alive. Manual intervention may be required.');

    // Keep process alive but do nothing
    await new Promise(() => { }); // Never resolves
  }
}

main();
