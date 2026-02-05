import { IBroker } from '../brokers/base';
import { logger } from '../utils/logger';

export interface MarginCheckResult {
    available: boolean;
    margin: number;
    required: number;
    shortfall: number;
}

export class MarginChecker {
    /**
     * Check if sufficient margin is available for an order
     */
    async checkMarginAvailable(
        broker: IBroker,
        orderValue: number,
        marginMultiplier: number = 5
    ): Promise<MarginCheckResult> {
        try {
            // Get account balance/margin from broker
            // For Angel One, getAccountBalance usually returns net available margin
            // But we should ideally check specifically against what the broker says is "available cash"
            // or "net" from RMS response.
            // Since BaseBroker has getAccountBalance, we'll use that as the primary source for now.
            // Ideally, specific broker implementations should expose detailed RMS info.

            const availableMargin = await broker.getAccountBalance();

            // For Intraday (MIS), required margin is Order Value / Multiplier
            const requiredMargin = orderValue / marginMultiplier;

            const isAvailable = availableMargin >= requiredMargin;

            if (!isAvailable) {
                logger.warn('Margin check failed', {
                    available: availableMargin,
                    required: requiredMargin,
                    shortfall: requiredMargin - availableMargin,
                    orderValue,
                    marginMultiplier
                });
            }

            return {
                available: isAvailable,
                margin: availableMargin,
                required: requiredMargin,
                shortfall: Math.max(0, requiredMargin - availableMargin)
            };
        } catch (error: any) {
            logger.error('Error checking margin availability', error);
            // Fail safe: if we can't check margin, assume NO margin (conservative) to prevent rejection
            return {
                available: false,
                margin: 0,
                required: orderValue / marginMultiplier,
                shortfall: orderValue / marginMultiplier
            };
        }
    }
}

export const marginChecker = new MarginChecker();
