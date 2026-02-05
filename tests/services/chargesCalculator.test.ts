import { chargesCalculator } from '../../src/services/chargesCalculator';
import { OrderSide } from '../../src/types';

describe('ChargesCalculator', () => {
    test('should calculate charges correctly for BUY order (Entry)', () => {
        // 100 shares @ 1000 = 100,000 turnover
        const value = 100000;
        const charges = chargesCalculator.calculateTotalCharges(value, OrderSide.BUY);

        // Expected breakdowns (approximate dates based on implementation)
        // Brokerage: 0.03% or 20, min of both. 100k * 0.0003 = 30. So max 20.
        // STT: 0 for intraday buy
        // Exchange: 0.00325% = 3.25
        // SEBI: 10 per crore = 10 / 100 = 0.1
        // Stamp: 0.003% = 3
        // GST: 18% of (Brokerage + Exchange + SEBI) = 0.18 * (20 + 3.25 + 0.1) = 0.18 * 23.35 = 4.203

        expect(charges.brokerage).toBe(20); // Capped
        expect(charges.stt).toBe(0);
        expect(charges.exchangeCharges).toBeCloseTo(3.25, 2);
        expect(charges.sebiCharges).toBeCloseTo(0.1, 2);
        expect(charges.stampDuty).toBe(3); // Buy only
        expect(charges.gst).toBeCloseTo(4.20, 1);

        // Total should matches sum
        const expectedTotal = 20 + 0 + 3.25 + 0.1 + 3 + 4.203;
        expect(charges.total).toBeCloseTo(expectedTotal, 1);
    });

    test('should calculate charges correctly for SELL order (Exit)', () => {
        // 100 shares @ 1000 = 100,000 turnover
        const value = 100000;
        const charges = chargesCalculator.calculateTotalCharges(value, OrderSide.SELL);

        // Differences for SELL:
        // Stamp Duty: 0 (Buyer pays)
        // STT: 0.025% for Sell = 25

        expect(charges.brokerage).toBe(20);
        expect(charges.stt).toBe(25);
        expect(charges.stampDuty).toBe(0);
        expect(charges.exchangeCharges).toBeCloseTo(3.25, 2);
        expect(charges.sebiCharges).toBeCloseTo(0.1, 2);

        // GST on Brokerage + Exchange + SEBI (No STT/Stamp in GST base)
        // 18% of (20 + 3.25 + 0.1) = 4.203
        expect(charges.gst).toBeCloseTo(4.20, 1);

        const expectedTotal = 20 + 25 + 0 + 3.25 + 0.1 + 4.203;
        expect(charges.total).toBeCloseTo(expectedTotal, 1);
    });
});
