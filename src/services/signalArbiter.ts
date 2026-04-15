import { EventEmitter } from 'events';
import { StrategySignal } from '../types';
import { logger } from '../utils/logger';

interface Buffered {
  strategyName: string;
  signal: StrategySignal;
}

/**
 * SignalArbiter
 *
 * Sits between strategies and the trading engine. When multiple strategies
 * fire on the same symbol within WINDOW_MS:
 *   • Same direction  → forward only the highest-confidence signal.
 *   • Conflicting dir → suppress all signals for that symbol (avoid whipsaw).
 *   • Single signal   → forward immediately after WINDOW_MS (no artificial delay
 *                        beyond the window, which is typically very short).
 *
 * Emits:
 *   'selected'  (signal: StrategySignal)  – the winning signal to execute
 */
export class SignalArbiter extends EventEmitter {
  /** How long to collect competing signals for the same symbol (ms). */
  private readonly WINDOW_MS: number;

  private buffer: Map<string, Buffered[]> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(windowMs = 15_000) {
    super();
    this.WINDOW_MS = windowMs;
  }

  /**
   * Submit a signal from a strategy. The arbiter will decide whether and
   * when to forward it to the engine.
   */
  submit(strategyName: string, signal: StrategySignal): void {
    const { symbol } = signal;

    if (!this.buffer.has(symbol)) {
      this.buffer.set(symbol, []);
    }
    this.buffer.get(symbol)!.push({ strategyName, signal });

    // Start the window timer only once per symbol per batch
    if (!this.timers.has(symbol)) {
      const timer = setTimeout(() => this.flush(symbol), this.WINDOW_MS);
      this.timers.set(symbol, timer);
    }

    logger.debug(`[SignalArbiter] Buffered ${strategyName} ${signal.action} for ${symbol}`, {
      confidence: signal.confidence,
      buffered: this.buffer.get(symbol)!.length,
    });
  }

  // ---------------------------------------------------------------------------

  private flush(symbol: string): void {
    this.timers.delete(symbol);
    const entries = this.buffer.get(symbol) ?? [];
    this.buffer.delete(symbol);

    if (entries.length === 0) return;

    const buys  = entries.filter(e => e.signal.action === 'BUY');
    const sells = entries.filter(e => e.signal.action === 'SELL');

    // Conflicting directions — suppress to avoid whipsaw
    if (buys.length > 0 && sells.length > 0) {
      const names = entries.map(e => `${e.strategyName}(${e.signal.action})`).join(', ');
      logger.info(`[SignalArbiter] Conflicting signals for ${symbol} [${names}] — suppressed`);
      return;
    }

    const candidates = buys.length > 0 ? buys : sells;

    // Pick the highest-confidence signal
    const winner = candidates.reduce((best, cur) =>
      (cur.signal.confidence ?? 0) > (best.signal.confidence ?? 0) ? cur : best,
    );

    if (candidates.length > 1) {
      const all = candidates
        .map(e => `${e.strategyName}(conf=${(e.signal.confidence ?? 0).toFixed(2)})`)
        .join(', ');
      logger.info(
        `[SignalArbiter] ${candidates.length} signals for ${symbol} [${all}]` +
        ` → selected ${winner.strategyName} (conf=${(winner.signal.confidence ?? 0).toFixed(2)})`,
      );
    }

    this.emit('selected', winner.signal);
  }
}
