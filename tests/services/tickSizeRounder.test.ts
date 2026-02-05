import { tickSizeRounder } from '../../src/services/tickSizeRounder';

describe('TickSizeRounder', () => {
    test('should round prices to nearest 0.05', () => {
        expect(tickSizeRounder.roundToTickSize(100.123)).toBeCloseTo(100.10);
        expect(tickSizeRounder.roundToTickSize(100.126)).toBeCloseTo(100.15);

        expect(tickSizeRounder.roundToTickSize(100.11)).toBeCloseTo(100.10);
        expect(tickSizeRounder.roundToTickSize(100.14)).toBeCloseTo(100.15);
    });

    test('should format price strings correctly', () => {
        expect(tickSizeRounder.formatPrice(100.1)).toBe('100.10');
        expect(tickSizeRounder.formatPrice(100)).toBe('100.00');
        expect(tickSizeRounder.formatPrice(100.123)).toBe('100.10');
    });
});
