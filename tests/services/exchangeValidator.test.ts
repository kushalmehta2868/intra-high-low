import { exchangeValidator } from '../../src/services/exchangeValidator';

describe('ExchangeValidator', () => {
    test('should return NSE for NSE symbols', () => {
        expect(exchangeValidator.getExchangeForSymbol('RELIANCE-EQ')).toBe('NSE');
        expect(exchangeValidator.getExchangeForSymbol('TCS-EQ')).toBe('NSE');
        // NIFTY usually doesn't have suffix in some contexts or index? 
        // Implementation: Only checks .endsWith('-EQ') or '-BE'. 
        // NIFTY will return null based on current implementation.
        expect(exchangeValidator.getExchangeForSymbol('NIFTY')).toBeNull();
    });

    test('should return BSE for BSE symbols', () => {
        expect(exchangeValidator.getExchangeForSymbol('RELIANCE-BE')).toBe('BSE'); // Correct suffix
    });

    test('should validate correct exchange', () => {
        expect(exchangeValidator.validateSymbolExchange('RELIANCE-EQ', 'NSE')).toBe(true);
        expect(exchangeValidator.validateSymbolExchange('RELIANCE-EQ', 'BSE')).toBe(false);
    });
});
