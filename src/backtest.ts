/**
 * backtest.ts — Trade Journal Win-Rate Analyser
 *
 * Reads trade_journal.jsonl (produced by the paper broker) and computes
 * per-strategy win-rate, average RR, profit factor, and cumulative PnL curve.
 *
 * CLI usage:
 *   npx ts-node src/backtest.ts [path/to/trade_journal.jsonl]
 *
 * Programmatic usage:
 *   import { runBacktest } from './backtest';
 *   const report = await runBacktest();
 *
 * JSONL event schema:
 *   Entry: { event: "SIGNAL_BUY"|"SIGNAL_SELL", tradeId, sym, strategy,
 *            entryPrice, stopLoss, target, qty, paper }
 *   Exit:  { event: "TAKE_PROFIT"|"STOP_LOSS", tradeId, sym, side,
 *            entryPrice, exitPrice, qty, paper }
 */

import fs       from 'fs';
import path     from 'path';
import readline from 'readline';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EntryEvent {
  event:      'SIGNAL_BUY' | 'SIGNAL_SELL';
  tradeId:    string;
  sym:        string;
  strategy:   string;
  entryPrice: number;
  stopLoss:   number;
  target:     number;
  qty:        number;
  paper:      boolean;
  timestamp?: string;
}

interface ExitEvent {
  event:      'TAKE_PROFIT' | 'STOP_LOSS';
  tradeId:    string;
  sym:        string;
  side:       'BUY' | 'SELL';
  entryPrice: number;
  exitPrice:  number;
  qty:        number;
  paper:      boolean;
  timestamp?: string;
}

interface Trade {
  entry:   EntryEvent;
  exit?:   ExitEvent;
  outcome: 'win' | 'loss' | 'open';
  pnlInr:  number;
  rr:      number;
}

interface StratStats {
  wins:      number;
  losses:    number;
  open:      number;
  totalPnl:  number;
  grossWin:  number;
  grossLoss: number;
  totalRR:   number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isEntry(e: any): e is EntryEvent {
  return e?.event === 'SIGNAL_BUY' || e?.event === 'SIGNAL_SELL';
}
function isExit(e: any): e is ExitEvent {
  return e?.event === 'TAKE_PROFIT' || e?.event === 'STOP_LOSS';
}
function pct(n: number, d: number): string {
  return d === 0 ? '—' : ((n / d) * 100).toFixed(1) + '%';
}
function fmt(n: number, dp = 2): string {
  return (n >= 0 ? '+' : '') + n.toFixed(dp);
}

// ─── Parse journal ────────────────────────────────────────────────────────────

export async function parseJournal(filePath: string): Promise<Trade[]> {
  const rl = readline.createInterface({
    input:     fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  const entries = new Map<string, EntryEvent>();
  const exits   = new Map<string, ExitEvent>();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (isEntry(obj) && obj.tradeId) entries.set(obj.tradeId, obj);
      if (isExit(obj)  && obj.tradeId) exits.set(obj.tradeId,   obj);
    } catch { /* malformed line — skip */ }
  }

  const trades: Trade[] = [];

  for (const [tradeId, entry] of entries) {
    const exit = exits.get(tradeId);

    if (!exit) {
      trades.push({ entry, exit: undefined, outcome: 'open', pnlInr: 0, rr: 0 });
      continue;
    }

    const slDist1R  = Math.abs(entry.entryPrice - entry.stopLoss);
    const side      = entry.event === 'SIGNAL_BUY' ? 'BUY' : 'SELL';
    const priceDiff = side === 'BUY'
      ? exit.exitPrice - entry.entryPrice
      : entry.entryPrice - exit.exitPrice;

    trades.push({
      entry,
      exit,
      outcome: exit.event === 'TAKE_PROFIT' ? 'win' : 'loss',
      pnlInr:  priceDiff * (entry.qty ?? 0),
      rr:      slDist1R > 0 ? priceDiff / slDist1R : 0,
    });
  }

  return trades;
}

// ─── Build report string ──────────────────────────────────────────────────────

export function buildReportString(trades: Trade[], forTelegram = false): string {
  const HR = forTelegram
    ? '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    : '═══════════════════════════════════════════════════════';

  const lines: string[] = [];
  const push = (...args: string[]) => lines.push(...args);

  const overall: StratStats = { wins: 0, losses: 0, open: 0, totalPnl: 0, grossWin: 0, grossLoss: 0, totalRR: 0 };
  const byStrategy = new Map<string, StratStats>();
  const getStats = (k: string): StratStats => {
    if (!byStrategy.has(k)) byStrategy.set(k, { wins: 0, losses: 0, open: 0, totalPnl: 0, grossWin: 0, grossLoss: 0, totalRR: 0 });
    return byStrategy.get(k)!;
  };

  trades.sort((a, b) => (a.entry.timestamp ?? '') < (b.entry.timestamp ?? '') ? -1 : 1);

  const curve: number[] = [];
  let running = 0;

  for (const t of trades) {
    const ss = getStats(t.entry.strategy ?? 'unknown');
    if (t.outcome === 'open') { overall.open++; ss.open++; continue; }

    if (t.outcome === 'win') {
      overall.wins++;  ss.wins++;
      overall.grossWin += t.pnlInr; ss.grossWin += t.pnlInr;
      overall.totalRR  += t.rr;     ss.totalRR  += t.rr;
    } else {
      overall.losses++; ss.losses++;
      overall.grossLoss += Math.abs(t.pnlInr); ss.grossLoss += Math.abs(t.pnlInr);
    }
    overall.totalPnl += t.pnlInr; ss.totalPnl += t.pnlInr;
    running += t.pnlInr;
    curve.push(running);
  }

  const closed = overall.wins + overall.losses;

  if (forTelegram) {
    push('📊 DAILY BACKTEST REPORT');
  } else {
    push(HR);
    push('  TRADE JOURNAL BACKTEST REPORT');
    push(HR);
  }

  push(`\nSignals: ${trades.length}  |  Closed: ${closed}  |  Open: ${overall.open}`);

  if (closed === 0) {
    push('\nNo closed trades yet — run the bot in paper mode to generate data.');
    return lines.join('\n');
  }

  const pf    = overall.grossLoss > 0 ? (overall.grossWin / overall.grossLoss).toFixed(2) : '∞';
  const avgRR = overall.wins > 0 ? (overall.totalRR / overall.wins).toFixed(2) : '—';

  let peak = 0, maxDD = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }

  push(HR);
  push('📈 OVERALL');
  push(`Win rate:      ${pct(overall.wins, closed)}  (${overall.wins}W / ${overall.losses}L)`);
  push(`Net PnL:       ${fmt(overall.totalPnl)} ₹`);
  push(`Gross win:     +${overall.grossWin.toFixed(2)} ₹`);
  push(`Gross loss:    -${overall.grossLoss.toFixed(2)} ₹`);
  push(`Profit factor: ${pf}`);
  push(`Avg win RR:    ${avgRR}R`);
  push(`Max drawdown:  -${maxDD.toFixed(2)} ₹`);

  const stratKeys = [...byStrategy.keys()].sort();
  const hasMultipleStrats = stratKeys.filter(k => {
    const s = byStrategy.get(k)!;
    return s.wins + s.losses > 0;
  }).length > 1;

  if (hasMultipleStrats) {
    push(HR);
    push('🗂 BY STRATEGY');
    for (const key of stratKeys) {
      const s  = byStrategy.get(key)!;
      const sc = s.wins + s.losses;
      if (sc === 0) continue;
      const spf    = s.grossLoss > 0 ? (s.grossWin / s.grossLoss).toFixed(2) : '∞';
      const sAvgRR = s.wins > 0 ? (s.totalRR / s.wins).toFixed(2) : '—';
      push(`\n${key.toUpperCase()}`);
      push(`  ${s.wins}W / ${s.losses}L  WR: ${pct(s.wins, sc)}  PnL: ${fmt(s.totalPnl)} ₹  PF: ${spf}  Avg RR: ${sAvgRR}R`);
    }
  }

  const closedTrades = trades.filter(t => t.outcome !== 'open');
  if (closedTrades.length > 0) {
    closedTrades.sort((a, b) => b.pnlInr - a.pnlInr);
    push(HR);
    push('🏆 BEST TRADES');
    for (const t of closedTrades.slice(0, 3)) {
      push(`  ${t.entry.sym} ${t.entry.event.replace('SIGNAL_', '')}  ${fmt(t.pnlInr)} ₹  ${t.rr.toFixed(1)}R  [${t.entry.strategy}]`);
    }

    closedTrades.sort((a, b) => a.pnlInr - b.pnlInr);
    push(HR);
    push('💀 WORST TRADES');
    for (const t of closedTrades.slice(0, 3)) {
      push(`  ${t.entry.sym} ${t.entry.event.replace('SIGNAL_', '')}  ${fmt(t.pnlInr)} ₹  ${t.rr.toFixed(1)}R  [${t.entry.strategy}]`);
    }
  }

  if (!forTelegram) push(HR);

  return lines.join('\n');
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function runBacktest(
  journalPath = path.join(process.cwd(), 'trade_journal.jsonl'),
  forTelegram = false,
): Promise<string> {
  if (!fs.existsSync(journalPath)) {
    return `Backtest: journal not found at ${journalPath}`;
  }
  try {
    const trades = await parseJournal(journalPath);
    return buildReportString(trades, forTelegram);
  } catch (err) {
    return `Backtest error: ${(err as Error).message}`;
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const journalPath = process.argv[2] ?? path.join(process.cwd(), 'trade_journal.jsonl');
  console.log(`Reading: ${journalPath}`);
  const report = await runBacktest(journalPath, false);
  console.log(report);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Backtest error:', err.message);
    process.exit(1);
  });
}
