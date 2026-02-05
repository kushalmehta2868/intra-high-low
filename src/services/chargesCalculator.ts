import { OrderSide } from '../types';

export class ChargesCalculator {
    /**
     * Calculate brokerage for Angel One (Intraday Equity)
     * Flat ₹20 or 0.03% (whichever is lower) per executed order
     */
    calculateBrokerage(orderValue: number): number {
        // 0.03% or ₹20, whichever is lower
        return Math.min(orderValue * 0.0003, 20);
    }

    /**
     * Calculate STT (Securities Transaction Tax)
     * 0.025% on SELL side only for intraday equity
     */
    calculateSTT(orderValue: number, side: OrderSide): number {
        return side === OrderSide.SELL ? orderValue * 0.00025 : 0;
    }

    /**
     * Calculate NSE Transaction Charges
     * 0.00325% on turnover (NSE Equity Intraday)
     */
    calculateExchangeCharges(orderValue: number): number {
        return orderValue * 0.0000325;
    }

    /**
     * Calculate SEBI Turnover Charges
     * ₹10 per crore (0.0001%)
     */
    calculateSEBICharges(orderValue: number): number {
        return orderValue * 0.000001;
    }

    /**
     * Calculate Stamp Duty
     * 0.003% on BUY side only (max cap varies by state, but usually negligible for intraday)
     */
    calculateStampDuty(orderValue: number, side: OrderSide): number {
        return side === OrderSide.BUY ? orderValue * 0.00003 : 0;
    }

    /**
     * Calculate GST
     * 18% on (Brokerage + Exchange Charges + SEBI Charges)
     */
    calculateGST(brokerage: number, exchangeCharges: number, sebiCharges: number): number {
        return (brokerage + exchangeCharges + sebiCharges) * 0.18;
    }

    /**
     * Calculate total charges for a single order (one leg of a trade)
     */
    calculateTotalCharges(orderValue: number, side: OrderSide): {
        brokerage: number;
        stt: number;
        exchangeCharges: number;
        sebiCharges: number;
        stampDuty: number;
        gst: number;
        total: number;
    } {
        const brokerage = this.calculateBrokerage(orderValue);
        const stt = this.calculateSTT(orderValue, side);
        const exchangeCharges = this.calculateExchangeCharges(orderValue);
        const sebiCharges = this.calculateSEBICharges(orderValue);
        const stampDuty = this.calculateStampDuty(orderValue, side);
        const gst = this.calculateGST(brokerage, exchangeCharges, sebiCharges);

        const total = brokerage + stt + exchangeCharges + sebiCharges + stampDuty + gst;

        return {
            brokerage,
            stt,
            exchangeCharges,
            sebiCharges,
            stampDuty,
            gst,
            total
        };
    }
}

export const chargesCalculator = new ChargesCalculator();
