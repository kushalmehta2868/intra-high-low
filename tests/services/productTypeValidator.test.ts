import { productTypeValidator } from '../../src/services/productTypeValidator';
import { PositionType } from '../../src/types';

describe('ProductTypeValidator', () => {
    test('should accept INTRADAY and MIS product types', () => {
        expect(productTypeValidator.validateOrderProductType('INTRADAY')).toBe(true);
        expect(productTypeValidator.validateOrderProductType('MIS')).toBe(true);
    });

    test('should reject CNC, DELIVERY, MARGIN, BO, CO', () => {
        expect(productTypeValidator.validateOrderProductType('CNC')).toBe(false);
        expect(productTypeValidator.validateOrderProductType('DELIVERY')).toBe(false);
        expect(productTypeValidator.validateOrderProductType('MARGIN')).toBe(false);
        expect(productTypeValidator.validateOrderProductType('BO')).toBe(false);
        expect(productTypeValidator.validateOrderProductType('CO')).toBe(false);
    });
});
