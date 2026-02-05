import { logger } from '../utils/logger';

export class ProductTypeValidator {
    /**
     * Validate that the product type is strictly INTRADAY / MIS
     */
    validateOrderProductType(productType: string): boolean {
        const validTypes = ['INTRADAY', 'MIS'];
        const normalizedType = productType.toUpperCase();

        if (!validTypes.includes(normalizedType)) {
            logger.error('Invalid product type detected', {
                productType,
                allowed: validTypes.join(', ')
            });
            return false;
        }
        return true;
    }

    /**
     * Validate that a position has the correct product type
     */
    validatePositionProductType(position: any): boolean {
        // Angel One positions usually have 'producttype' or 'product' field
        const productType = position.producttype || position.product;

        if (!productType) {
            logger.warn('Position missing product type field', { position });
            // If we can't determine, log warning but don't strictly fail unless configured
            // For safety, let's return false to trigger alerts if strictly enforced
            return false;
        }

        return this.validateOrderProductType(productType);
    }
}

export const productTypeValidator = new ProductTypeValidator();
