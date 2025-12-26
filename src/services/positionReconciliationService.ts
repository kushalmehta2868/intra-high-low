import { EventEmitter } from 'events';
import { IBroker } from '../brokers/base';
import { PositionManager } from '../core/positionManager';
import { logger } from '../utils/logger';
import { Position } from '../types';

export interface ReconciliationMismatch {
  symbol: string;
  issue: 'MISSING_IN_BOT' | 'MISSING_IN_BROKER' | 'QUANTITY_MISMATCH' | 'PRICE_MISMATCH';
  botPosition?: Position;
  brokerPosition?: Position;
  details: string;
}

/**
 * Position Reconciliation Service
 * Compares bot's position tracking with broker's actual positions
 * Runs every 30 seconds to detect and alert on discrepancies
 */
export class PositionReconciliationService extends EventEmitter {
  private broker: IBroker;
  private positionManager: PositionManager;
  private reconciliationInterval: NodeJS.Timeout | null = null;
  private readonly RECONCILIATION_INTERVAL_MS = 30000; // 30 seconds
  private isRunning: boolean = false;

  // Track consecutive reconciliation failures
  private consecutiveFailures: number = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 3;

  constructor(broker: IBroker, positionManager: PositionManager) {
    super();
    this.broker = broker;
    this.positionManager = positionManager;
  }

  /**
   * Start position reconciliation loop
   */
  public start(): void {
    if (this.isRunning) {
      logger.warn('Position reconciliation already running');
      return;
    }

    this.isRunning = true;

    logger.info('Starting position reconciliation service', {
      intervalMs: this.RECONCILIATION_INTERVAL_MS
    });

    // Run immediately on start
    this.reconcile();

    // Then run every 30 seconds
    this.reconciliationInterval = setInterval(() => {
      this.reconcile();
    }, this.RECONCILIATION_INTERVAL_MS);
  }

  /**
   * Stop position reconciliation loop
   */
  public stop(): void {
    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
    }

    this.isRunning = false;
    logger.info('Position reconciliation service stopped');
  }

  /**
   * Perform position reconciliation
   */
  private async reconcile(): Promise<void> {
    try {
      logger.debug('Running position reconciliation...');

      // Get positions from both sources
      const botPositions = this.positionManager.getAllPositions();
      const brokerPositions = await this.broker.getPositions();

      const mismatches: ReconciliationMismatch[] = [];

      // Check for positions in broker but not in bot
      for (const brokerPos of brokerPositions) {
        const botPos = botPositions.find(p => p.symbol === brokerPos.symbol);

        if (!botPos) {
          mismatches.push({
            symbol: brokerPos.symbol,
            issue: 'MISSING_IN_BOT',
            brokerPosition: brokerPos,
            details: `Broker shows position in ${brokerPos.symbol} (qty: ${brokerPos.quantity}) but bot is not tracking it`
          });
        } else {
          // Position exists in both, check quantity
          if (botPos.quantity !== brokerPos.quantity) {
            mismatches.push({
              symbol: brokerPos.symbol,
              issue: 'QUANTITY_MISMATCH',
              botPosition: botPos,
              brokerPosition: brokerPos,
              details: `Quantity mismatch: Bot=${botPos.quantity}, Broker=${brokerPos.quantity}`
            });
          }

          // Check price mismatch (allow 5% tolerance for minor differences)
          const priceDiff = Math.abs(botPos.entryPrice - brokerPos.entryPrice) / brokerPos.entryPrice;
          if (priceDiff > 0.05) {
            mismatches.push({
              symbol: brokerPos.symbol,
              issue: 'PRICE_MISMATCH',
              botPosition: botPos,
              brokerPosition: brokerPos,
              details: `Entry price mismatch: Bot=₹${botPos.entryPrice.toFixed(2)}, Broker=₹${brokerPos.entryPrice.toFixed(2)} (${(priceDiff * 100).toFixed(2)}% diff)`
            });
          }
        }
      }

      // Check for positions in bot but not in broker
      for (const botPos of botPositions) {
        const brokerPos = brokerPositions.find(p => p.symbol === botPos.symbol);

        if (!brokerPos) {
          mismatches.push({
            symbol: botPos.symbol,
            issue: 'MISSING_IN_BROKER',
            botPosition: botPos,
            details: `Bot is tracking position in ${botPos.symbol} (qty: ${botPos.quantity}) but broker shows no position`
          });
        }
      }

      // Handle mismatches
      if (mismatches.length > 0) {
        this.consecutiveFailures++;

        logger.error('❌ POSITION RECONCILIATION MISMATCHES DETECTED', {
          totalMismatches: mismatches.length,
          consecutiveFailures: this.consecutiveFailures
        });

        for (const mismatch of mismatches) {
          logger.error('Reconciliation mismatch', {
            symbol: mismatch.symbol,
            issue: mismatch.issue,
            details: mismatch.details
          });
        }

        // Emit mismatch event
        this.emit('reconciliation_mismatch', {
          mismatches,
          consecutiveFailures: this.consecutiveFailures
        });

        // Log to audit
        logger.audit('RECONCILIATION_MISMATCH', {
          mismatches: mismatches.map(m => ({
            symbol: m.symbol,
            issue: m.issue,
            details: m.details
          })),
          consecutiveFailures: this.consecutiveFailures
        });

        // Critical: If multiple consecutive failures, emit critical alert
        if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
          logger.error('🚨 CRITICAL: Multiple consecutive reconciliation failures', {
            failures: this.consecutiveFailures
          });

          this.emit('reconciliation_critical', {
            message: `${this.consecutiveFailures} consecutive reconciliation failures detected`,
            mismatches
          });
        }
      } else {
        // No mismatches, reset failure counter
        if (this.consecutiveFailures > 0) {
          logger.info('✅ Reconciliation recovered - positions now match', {
            previousFailures: this.consecutiveFailures
          });
        }

        this.consecutiveFailures = 0;

        logger.debug('✅ Position reconciliation successful - no mismatches', {
          botPositions: botPositions.length,
          brokerPositions: brokerPositions.length
        });

        this.emit('reconciliation_success', {
          botPositionCount: botPositions.length,
          brokerPositionCount: brokerPositions.length
        });
      }
    } catch (error: any) {
      logger.error('Error during position reconciliation', {
        error: error.message
      });

      this.consecutiveFailures++;

      this.emit('reconciliation_error', {
        error: error.message,
        consecutiveFailures: this.consecutiveFailures
      });
    }
  }

  /**
   * Manually trigger reconciliation (for testing or on-demand checks)
   */
  public async triggerReconciliation(): Promise<void> {
    await this.reconcile();
  }

  /**
   * Get reconciliation status
   */
  public getStatus() {
    return {
      isRunning: this.isRunning,
      intervalMs: this.RECONCILIATION_INTERVAL_MS,
      consecutiveFailures: this.consecutiveFailures,
      isHealthy: this.consecutiveFailures < this.MAX_CONSECUTIVE_FAILURES
    };
  }
}
