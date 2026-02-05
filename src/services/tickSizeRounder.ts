export class TickSizeRounder {
    /**
     * Round price to nearest tick size based on NSE equity rules
     */
    roundToTickSize(price: number): number {
        if (price < 1000) {
            // Tick size: ₹0.05
            return Math.round(price / 0.05) * 0.05;
        } else if (price < 3000) {
            // Tick size: ₹0.10 (Standard for some segments, but NSE usually 0.05 for all equities)
            // Note: NSE Equity tick size is generally 0.05 everywhere.
            // However, keeping this extensible if logic changes.
            // For now, let's stick to 0.05 strictly for NSE Equities as per standard.
            return Math.round(price / 0.05) * 0.05;
        } else {
            // Tick size: ₹0.05
            return Math.round(price / 0.05) * 0.05;
        }
    }

    /**
     * Format price string with 2 decimal places after rounding
     */
    formatPrice(price: number): string {
        return this.roundToTickSize(price).toFixed(2);
    }
}

export const tickSizeRounder = new TickSizeRounder();
