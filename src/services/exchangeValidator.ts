import { logger } from '../utils/logger';

export class ExchangeValidator {
    /**
     * Determine the correct exchange for a given symbol based on suffix
     */
    getExchangeForSymbol(symbol: string): 'NSE' | 'BSE' | null {
        // Parse symbol suffix
        if (symbol.endsWith('-EQ')) {
            return 'NSE'; // NSE Equity
        } else if (symbol.endsWith('-BE')) {
            return 'BSE'; // BSE Equity (rare for intraday, but possible)
        }

        // Default fallback or error
        logger.error('Unknown exchange for symbol (missing suffix)', { symbol });
        return null;
    }

    /**
     * Validate that the requested exchange matches the symbol's correct exchange
     */
    validateSymbolExchange(symbol: string, requestedExchange: string): boolean {
        const correctExchange = this.getExchangeForSymbol(symbol);

        if (!correctExchange) {
            return false; // Cannot validate
        }

        if (correctExchange !== requestedExchange) {
            logger.error('Exchange mismatch', {
                symbol,
                expected: correctExchange,
                got: requestedExchange
            });
            return false;
        }

        return true;
    }
}

export const exchangeValidator = new ExchangeValidator();
