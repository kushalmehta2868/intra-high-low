export interface CircuitStatus {
    atCircuit: boolean;
    type?: 'UPPER' | 'LOWER';
    limit?: number;
}

export class CircuitLimitDetector {
    /**
     * Check if current price is at circuit limit
     */
    isAtCircuit(currentPrice: number, open: number, high: number, low: number): CircuitStatus {
        // Circuit limits are typically percentages from PREVIOUS CLOSE, not Open.
        // However, if we don't have prevClose, we might use Open as approximation or check if High=Low=Open on strong trends.
        // Better logic: if LTP is equal to High or Low, and the move is significant (e.g. 5%, 10%, 20%)

        // For Intraday bot safety: if we are buying and price is at HIGH and HIGH is significantly up, caution.
        // Real circuit check needs 'upper_circuit_limit' and 'lower_circuit_limit' from market data if available.
        // Since we receive OHLC, we can check if LTP == High (Upper) or LTP == Low (Lower)
        // AND if there is no volume at the offer/bid (which we might not have in simple quote).

        // Approximation:
        // If LTP == High and the candle looks like a strong move (e.g. >2% from Open), flag it.

        // Without strict circuit level data, we will use a naive approach:
        // If we're buying, and High == LTP, check if we are very far from Open.

        // Note: This is an approximation. Real circuit values are best. 
        // If broker provides circuit limits in quote, use those.
        // Assuming standard quote data:

        return { atCircuit: false }; // Placeholder until we can integrate real circuit bands from API
    }

    /**
     * Improved check using explicit circuit limits if available
     */
    isAtCircuitLimit(currentPrice: number, upperCircuit: number, lowerCircuit: number): CircuitStatus {
        if (Math.abs(currentPrice - upperCircuit) < 0.05) {
            return { atCircuit: true, type: 'UPPER', limit: upperCircuit };
        }
        if (Math.abs(currentPrice - lowerCircuit) < 0.05) {
            return { atCircuit: true, type: 'LOWER', limit: lowerCircuit };
        }
        return { atCircuit: false };
    }
}

export const circuitLimitDetector = new CircuitLimitDetector();
