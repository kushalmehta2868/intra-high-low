import { RiskManager } from '../../src/risk/riskManager';
import { RiskLimits, OrderSide } from '../../src/types';
import { chargesCalculator } from '../../src/services/chargesCalculator';

// Mock charges calculator to have predictable charges
jest.mock('../../src/services/chargesCalculator');

describe('RiskManager', () => {
    let riskManager: RiskManager;
    const defaultRiskLimits: RiskLimits = {
        maxRiskPerTradePercent: 1,
        maxDailyLossPercent: 2,
        positionSizePercent: 10,
        marginMultiplier: 5,
        useMargin: true
    };
    const startingBalance = 100000;

    beforeEach(() => {
        jest.clearAllMocks();
        riskManager = new RiskManager(defaultRiskLimits, startingBalance);

        // Mock charges to return simple values
        (chargesCalculator.calculateTotalCharges as jest.Mock).mockReturnValue({
            total: 50 // Fixed 50 charges for test simplicity
        });
    });

    describe('checkOrderRisk', () => {
        test('should allow order within limits', () => {
            const result = riskManager.checkOrderRisk('REL', OrderSide.BUY, 10, 1000, 950);
            expect(result.allowed).toBe(true);
        });

        test('should reject if max open positions reached', () => {
            // New Feature: Max 5 positions
            const MAX_POSITIONS = 5;
            const result = riskManager.checkOrderRisk('REL', OrderSide.BUY, 10, 1000, 950, MAX_POSITIONS);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Max open positions limit reached');
        });

        test('should reject if position size exceeds limit', () => {
            // Max size 10% of (100k * 5) = 50k
            // Try 60k order
            const result = riskManager.checkOrderRisk('REL', OrderSide.BUY, 60, 1000, 950);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Position size exceeds limit');
        });

        test('should reject if risk per trade exceeds limit', () => {
            // Max risk 1% of 100k = 1000
            // Position Size Limit = 10% of 500k (with margin) = 50k

            // Try Quantity 40 @ 1000 = 40,000 (Passes Position Size)
            // Stop Loss 970 (Risk 30 per share)
            // Total Risk = 40 * 30 = 1200 (Exceeds 1000)

            const result = riskManager.checkOrderRisk('REL', OrderSide.BUY, 40, 1000, 970);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Risk per trade exceeds limit');
        });
    });

    describe('recordTrade and PnL', () => {
        test('should calculate Net PnL after charges', () => {
            // Win 1000 Gross
            // Charges 50 (Entry) + 50 (Exit) = 100 in implementation logic? 
            // riskManager calls calculateTotalCharges for Entry and Exit

            riskManager.recordTrade(1000, {
                symbol: 'REL',
                side: 'BUY',
                quantity: 10,
                entryPrice: 1000,
                exitPrice: 1100
            });

            // Entry Charges + Exit Charges mocked 
            // In recordTrade logic: 
            // entryCharges = chargesCalculator.calculateTotalCharges(EntryValue) -> returns {total: 50}
            // exitCharges = chargesCalculator.calculateTotalCharges(ExitValue) -> returns {total: 50}
            // Total Charges = 100

            // Net PnL = 1000 - 100 = 900

            const stats = riskManager.getRiskStats();
            expect(stats.dailyPnL).toBe(900);
        });

        test('should reject orders after daily loss limit exceeded', () => {
            // Max Daily Loss: 2% of 100k = 2000

            // Loss 3000 Gross
            // Charges 100
            // Net Loss 3100

            riskManager.recordTrade(-3000, {
                symbol: 'REL',
                side: 'BUY',
                quantity: 10,
                entryPrice: 1000,
                exitPrice: 700
            });

            const stats = riskManager.getRiskStats();
            expect(stats.dailyPnL).toBe(-3100);

            // Next order should fail
            const result = riskManager.checkOrderRisk('TCS', OrderSide.BUY, 10, 1000, 950);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Max daily loss limit reached');
        });
    });
});
