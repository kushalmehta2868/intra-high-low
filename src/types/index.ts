export enum TradingMode {
  PAPER = 'PAPER',
  REAL = 'REAL'
}

export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL'
}

export enum OrderType {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
  STOP_LOSS = 'STOP_LOSS',
  STOP_LOSS_MARKET = 'STOP_LOSS_MARKET'
}

export enum OrderStatus {
  PENDING = 'PENDING',
  SUBMITTED = 'SUBMITTED',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  CANCELLED = 'CANCELLED',
  REJECTED = 'REJECTED'
}

export enum PositionType {
  LONG = 'LONG',
  SHORT = 'SHORT'
}

export interface Candle {
  symbol: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Order {
  orderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  status: OrderStatus;
  filledQuantity: number;
  averagePrice: number;
  timestamp: Date;
  broker?: string;
}

export interface Position {
  symbol: string;
  type: PositionType;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss?: number;
  target?: number;
  pnl: number;
  pnlPercent: number;
  entryTime: Date;
}

export interface Trade {
  tradeId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  timestamp: Date;
  orderId: string;
}

export interface StrategySignal {
  symbol: string;
  action: 'BUY' | 'SELL' | 'CLOSE';
  quantity?: number;
  stopLoss?: number;
  target?: number;
  reason: string;
  confidence?: number;
  marginMultiplier?: number;  // Per-symbol margin multiplier (e.g., 5 for MIS stocks)
}

export interface MarketData {
  symbol: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: Date;
}

export interface RiskLimits {
  maxRiskPerTradePercent: number;
  maxTradesPerDay: number;
  maxDailyLossPercent: number;
  positionSizePercent: number;
  marginMultiplier: number; // Intraday margin leverage (e.g., 5 for MIS, 1 for CNC)
  useMargin: boolean; // Enable/disable margin usage
}

export interface TradingConfig {
  mode: TradingMode;
  autoSquareOffTime: string;
  marketStartTime: string;
  marketEndTime: string;
  killSwitch: boolean;
  riskLimits: RiskLimits;
}

export interface BrokerConfig {
  apiKey: string;
  clientId: string;
  password: string;
  totpSecret: string;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface AppConfig {
  trading: TradingConfig;
  broker: BrokerConfig;
  telegram: TelegramConfig;
  logLevel: string;
  enableAuditLog: boolean;
}

export interface AccountInfo {
  balance: number;
  availableMargin: number;
  usedMargin: number;
  realizedPnL: number;
  unrealizedPnL: number;
  marginMultiplier: number; // Current margin multiplier being used
  effectiveBuyingPower: number; // Balance * marginMultiplier
}

export interface StrategyContext {
  marketData: Map<string, MarketData>;
  positions: Map<string, Position>;
  accountInfo: AccountInfo;
  config: TradingConfig;
}
