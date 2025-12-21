import { EventEmitter } from 'events';
import { IBroker } from '../brokers/base';
import { Position } from '../types';
import { logger } from '../utils/logger';

interface PositionMismatch {
  symbol: string;
  localPosition: Position | null;
  brokerPosition: Position | null;
  mismatchType: 'MISSING_LOCAL' | 'MISSING_BROKER' | 'QUANTITY_MISMATCH' | 'PRICE_MISMATCH';
  details: string;
}

/**
 * Position Reconciliation Service
 * Ensures bot's position tracking matches broker's actual positions
 * Prevents position drift and helps recover from crashes
 */
export class PositionReconciliationService extends EventEmitter {
  private broker: IBroker;
  private localPositions: Map<string, Position>;
  private isRunning: boolean = false;
  private reconciliationInterval: NodeJS.Timeout | null = null;
  private readonly RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private lastReconciliationTime: Date | null = null;
  private mismatchCount: number = 0;

  constructor(broker: IBroker, localPositions: Map<string, Position>) {
    super();
    this.broker = broker;
    this.localPositions = localPositions;
  }

  /**
   * Start periodic reconciliation
   */
  public start(): void {
    if (this.isRunning) {
      logger.warn('Position reconciliation already running');
      return;
    }

    logger.info('🔄 Starting position reconciliation service...');
    this.isRunning = true;

    // Reconcile immediately on start
    this.reconcile();

    // Then reconcile periodically
    this.reconciliationInterval = setInterval(() => {
      this.reconcile();
    }, this.RECONCILIATION_INTERVAL_MS);

    logger.info(`✅ Position reconciliation started (every ${this.RECONCILIATION_INTERVAL_MS / 60000} minutes)`);
  }

  /**
   * Stop periodic reconciliation
   */
  public stop(): void {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping position reconciliation service...');
    this.isRunning = false;

    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
    }

    logger.info('✅ Position reconciliation stopped');
  }

  /**
   * Perform reconciliation check
   */
  public async reconcile(): Promise<void> {
    try {
      logger.info('🔍 Starting position reconciliation...');

      const brokerPositions = await this.broker.getPositions();
      const mismatches: PositionMismatch[] = [];

      // Create maps for easier comparison
      const brokerPositionsMap = new Map<string, Position>();
      for (const pos of brokerPositions) {
        brokerPositionsMap.set(pos.symbol, pos);
      }

      // Check for positions in broker but not in local tracking
      for (const [symbol, brokerPos] of brokerPositionsMap) {
        const localPos = this.localPositions.get(symbol);

        if (!localPos) {
          mismatches.push({
            symbol,
            localPosition: null,
            brokerPosition: brokerPos,
            mismatchType: 'MISSING_LOCAL',
            details: `Position exists at broker (${brokerPos.quantity} shares) but not in local tracking`
          });
        } else {
          // Check for quantity mismatches
          if (localPos.quantity !== brokerPos.quantity) {
            mismatches.push({
              symbol,
              localPosition: localPos,
              brokerPosition: brokerPos,
              mismatchType: 'QUANTITY_MISMATCH',
              details: `Quantity mismatch - Local: ${localPos.quantity}, Broker: ${brokerPos.quantity}`
            });
          }

          // Check for significant price mismatches (>1%)
          const priceDiff = Math.abs(localPos.entryPrice - brokerPos.entryPrice);
          const priceDiffPercent = (priceDiff / brokerPos.entryPrice) * 100;

          if (priceDiffPercent > 1) {
            mismatches.push({
              symbol,
              localPosition: localPos,
              brokerPosition: brokerPos,
              mismatchType: 'PRICE_MISMATCH',
              details: `Entry price mismatch - Local: ₹${localPos.entryPrice.toFixed(2)}, Broker: ₹${brokerPos.entryPrice.toFixed(2)} (${priceDiffPercent.toFixed(2)}% diff)`
            });
          }
        }
      }

      // Check for positions in local tracking but not at broker
      for (const [symbol, localPos] of this.localPositions) {
        if (!brokerPositionsMap.has(symbol)) {
          mismatches.push({
            symbol,
            localPosition: localPos,
            brokerPosition: null,
            mismatchType: 'MISSING_BROKER',
            details: `Position exists in local tracking (${localPos.quantity} shares) but not at broker`
          });
        }
      }

      this.lastReconciliationTime = new Date();
      this.mismatchCount = mismatches.length;

      if (mismatches.length > 0) {
        logger.error('⚠️  POSITION MISMATCHES DETECTED', {
          count: mismatches.length,
          mismatches: mismatches.map(m => ({
            symbol: m.symbol,
            type: m.mismatchType,
            details: m.details
          }))
        });

        logger.audit('POSITION_MISMATCH', {
          count: mismatches.length,
          mismatches
        });

        this.emit('mismatches_detected', mismatches);

        // Log each mismatch in detail
        for (const mismatch of mismatches) {
          this.handleMismatch(mismatch);
        }
      } else {
        logger.info('✅ Position reconciliation complete - all positions match', {
          localPositions: this.localPositions.size,
          brokerPositions: brokerPositions.length
        });
      }

      this.emit('reconciliation_complete', {
        mismatches: mismatches.length,
        localPositions: this.localPositions.size,
        brokerPositions: brokerPositions.length
      });

    } catch (error: any) {
      logger.error('Error during position reconciliation', error);
      this.emit('reconciliation_error', error);
    }
  }

  /**
   * Handle a detected mismatch
   */
  private handleMismatch(mismatch: PositionMismatch): void {
    switch (mismatch.mismatchType) {
      case 'MISSING_LOCAL':
        logger.warn(`🔧 AUTO-FIX: Adding missing position to local tracking`, {
          symbol: mismatch.symbol,
          position: mismatch.brokerPosition
        });

        // Auto-fix: Add broker position to local tracking
        if (mismatch.brokerPosition) {
          this.localPositions.set(mismatch.symbol, mismatch.brokerPosition);
          this.emit('position_auto_added', mismatch.brokerPosition);
        }
        break;

      case 'MISSING_BROKER':
        logger.error(`❌ CRITICAL: Position in local tracking but not at broker`, {
          symbol: mismatch.symbol,
          localPosition: mismatch.localPosition
        });

        // This is critical - local position should be removed
        // But we don't auto-fix this as it might indicate a real issue
        this.emit('position_orphaned', mismatch.localPosition);
        break;

      case 'QUANTITY_MISMATCH':
        logger.error(`❌ CRITICAL: Quantity mismatch detected`, {
          symbol: mismatch.symbol,
          localQuantity: mismatch.localPosition?.quantity,
          brokerQuantity: mismatch.brokerPosition?.quantity
        });

        // Update local position with broker's quantity
        if (mismatch.brokerPosition) {
          const updatedPosition = {
            ...mismatch.localPosition!,
            quantity: mismatch.brokerPosition.quantity
          };
          this.localPositions.set(mismatch.symbol, updatedPosition);
          this.emit('position_quantity_synced', updatedPosition);
        }
        break;

      case 'PRICE_MISMATCH':
        logger.warn(`⚠️  Entry price mismatch`, {
          symbol: mismatch.symbol,
          localPrice: mismatch.localPosition?.entryPrice,
          brokerPrice: mismatch.brokerPosition?.entryPrice
        });

        // Update local position with broker's entry price
        if (mismatch.brokerPosition) {
          const updatedPosition = {
            ...mismatch.localPosition!,
            entryPrice: mismatch.brokerPosition.entryPrice
          };
          this.localPositions.set(mismatch.symbol, updatedPosition);
          this.emit('position_price_synced', updatedPosition);
        }
        break;
    }
  }

  /**
   * Get reconciliation status
   */
  public getStatus() {
    return {
      isRunning: this.isRunning,
      lastReconciliationTime: this.lastReconciliationTime,
      mismatchCount: this.mismatchCount,
      localPositionsCount: this.localPositions.size
    };
  }

  /**
   * Force immediate reconciliation
   */
  public async forceReconcile(): Promise<void> {
    logger.info('🔄 Forcing immediate position reconciliation...');
    await this.reconcile();
  }

  /**
   * Sync all positions from broker (use on startup or after crash)
   */
  public async syncFromBroker(): Promise<void> {
    try {
      logger.info('🔄 Syncing all positions from broker...');

      const brokerPositions = await this.broker.getPositions();

      // Clear local positions
      this.localPositions.clear();

      // Add all broker positions to local tracking
      for (const position of brokerPositions) {
        this.localPositions.set(position.symbol, position);
      }

      logger.info('✅ Position sync complete', {
        syncedPositions: brokerPositions.length
      });

      logger.audit('POSITIONS_SYNCED_FROM_BROKER', {
        count: brokerPositions.length,
        symbols: brokerPositions.map(p => p.symbol)
      });

      this.emit('positions_synced', brokerPositions);

    } catch (error: any) {
      logger.error('Error syncing positions from broker', error);
      throw error;
    }
  }
}
