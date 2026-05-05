import fs   from 'fs';
import path from 'path';

const JOURNAL_PATH = path.join(process.cwd(), 'trade_journal.jsonl');

function append(record: Record<string, unknown>): void {
  const line = JSON.stringify({ ...record, timestamp: new Date().toISOString() });
  fs.appendFileSync(JOURNAL_PATH, line + '\n');
}

export interface SignalEntry {
  tradeId:    string;
  symbol:     string;
  strategy:   string;
  side:       'BUY' | 'SELL';
  entryPrice: number;
  stopLoss:   number;
  target:     number;
  quantity:   number;
  paper:      boolean;
}

export interface TradeExit {
  tradeId:    string;
  symbol:     string;
  side:       'BUY' | 'SELL';
  entryPrice: number;
  exitPrice:  number;
  quantity:   number;
  paper:      boolean;
}

export const tradeJournal = {
  logSignal(entry: SignalEntry): void {
    append({
      event:      entry.side === 'BUY' ? 'SIGNAL_BUY' : 'SIGNAL_SELL',
      tradeId:    entry.tradeId,
      sym:        entry.symbol,
      strategy:   entry.strategy,
      entryPrice: entry.entryPrice,
      stopLoss:   entry.stopLoss,
      target:     entry.target,
      qty:        entry.quantity,
      paper:      entry.paper,
    });
  },

  logExit(exit: TradeExit, outcome: 'TAKE_PROFIT' | 'STOP_LOSS'): void {
    append({
      event:      outcome,
      tradeId:    exit.tradeId,
      sym:        exit.symbol,
      side:       exit.side,
      entryPrice: exit.entryPrice,
      exitPrice:  exit.exitPrice,
      qty:        exit.quantity,
      paper:      exit.paper,
    });
  },
};
