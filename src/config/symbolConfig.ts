/**
 * Symbol-specific configuration including margin multipliers
 *
 * Margin Multipliers:
 * - MIS (Intraday): Typically 5x for most stocks, can be up to 20x for certain stocks
 * - CNC (Delivery): 1x (no margin)
 *
 * Update these values based on your broker's margin requirements
 */

export interface SymbolConfig {
  symbol: string;
  marginMultiplier: number;  // Intraday margin leverage (e.g., 5 for MIS)
}

export const SYMBOL_CONFIGS: Record<string, SymbolConfig> = {
  'RELIANCE-EQ': { symbol: 'RELIANCE-EQ', marginMultiplier: 5 },
  'TCS-EQ': { symbol: 'TCS-EQ', marginMultiplier: 5 },
  'INFY-EQ': { symbol: 'INFY-EQ', marginMultiplier: 5 },
  'HDFCBANK-EQ': { symbol: 'HDFCBANK-EQ', marginMultiplier: 5 },
  'ICICIBANK-EQ': { symbol: 'ICICIBANK-EQ', marginMultiplier: 5 },
  'TRENT-EQ': { symbol: 'TRENT-EQ', marginMultiplier: 5 },
  'ULTRACEMCO-EQ': { symbol: 'ULTRACEMCO-EQ', marginMultiplier: 5 },
  'MUTHOOTFIN-EQ': { symbol: 'MUTHOOTFIN-EQ', marginMultiplier: 5 },
  'COFORGE-EQ': { symbol: 'COFORGE-EQ', marginMultiplier: 5 },
  'ABB-EQ': { symbol: 'ABB-EQ', marginMultiplier: 5 },
  'ALKEM-EQ': { symbol: 'ALKEM-EQ', marginMultiplier: 5 },
  'AMBER-EQ': { symbol: 'AMBER-EQ', marginMultiplier: 5 },
  'ANGELONE-EQ': { symbol: 'ANGELONE-EQ', marginMultiplier: 5 },
  'APOLLOHOSP-EQ': { symbol: 'APOLLOHOSP-EQ', marginMultiplier: 5 },
  'BAJAJ-AUTO-EQ': { symbol: 'BAJAJ-AUTO-EQ', marginMultiplier: 5 },
  'BHARTIARTL-EQ': { symbol: 'BHARTIARTL-EQ', marginMultiplier: 5 },
  'BRITANNIA-EQ': { symbol: 'BRITANNIA-EQ', marginMultiplier: 5 },
  'BSE-EQ': { symbol: 'BSE-EQ', marginMultiplier: 5 },
  'CUMMINSIND-EQ': { symbol: 'CUMMINSIND-EQ', marginMultiplier: 5 },
  'DIXON-EQ': { symbol: 'DIXON-EQ', marginMultiplier: 5 },
  'GRASIM-EQ': { symbol: 'GRASIM-EQ', marginMultiplier: 5 },
  'HAL-EQ': { symbol: 'HAL-EQ', marginMultiplier: 5 },
  'HDFCAMC-EQ': { symbol: 'HDFCAMC-EQ', marginMultiplier: 5 },
  'HEROMOTOCO-EQ': { symbol: 'HEROMOTOCO-EQ', marginMultiplier: 5 }
};

/**
 * Get margin multiplier for a symbol
 * @param symbol Trading symbol
 * @returns Margin multiplier (defaults to 5 if not found)
 */
export function getSymbolMarginMultiplier(symbol: string): number {
  return SYMBOL_CONFIGS[symbol]?.marginMultiplier ?? 5;
}

/**
 * Get symbol configuration
 * @param symbol Trading symbol
 * @returns Symbol configuration
 */
export function getSymbolConfig(symbol: string): SymbolConfig {
  return SYMBOL_CONFIGS[symbol] ?? { symbol, marginMultiplier: 5 };
}
