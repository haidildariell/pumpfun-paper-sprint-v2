// Pulse Five — a momentum-rotation paper-trading bot for the pump.fun
// replay harness (agent-fun/replay/v2).
//
// Why it is built this way:
// - The graded run must finish inside the wall budget, so every batch costs
//   one pass over that batch's own events plus a scan of at most five held
//   positions. Nothing ever scans the whole universe of curves.
// - The harness executes every entry twice and the two order logs must
//   match byte for byte, so this bot never reads the clock, the
//   environment or Math.random: each decision is a pure function of the
//   hello, the batch and the fills the harness reported.
// - Flow is aggregated in fixed 25-slot windows. A mint only becomes a
//   candidate from the window it traded in, which keeps the rolling map
//   small and the momentum signal fresh.
//
// Strategy in one paragraph: when a young, liquid curve prints a burst of
// buy flow (buy quote at least twice the sell quote and at least 2 SOL in
// the current window), open a fixed 0.05 SOL ticket, at most five positions
// at once. Close on +25% take-profit, -20% stop-loss, or after 4.000 slots
// held, whichever comes first. Stop opening new positions after a 35%
// drawdown from the equity peak; exits always stay live.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, Holding, OrderInput } from './vendor/makefun-bot.ts';

const TICKET_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per entry
const ROUND_TRIP_FLOOR = 10_000_000n; // guardrail minimum: 0.01 SOL
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 2_000;
const TAKE_PROFIT_NUM = 12_500n; // +25% over cost, scaled by 10_000
const STOP_LOSS_NUM = 8_000n; // -20% under cost, scaled by 10_000
const SCALE = 10_000n;
const MAX_HOLD_SLOTS = 4_000;
const MIN_AGE_SLOTS = 25;
const WINDOW_SLOTS = 25;
const MIN_REAL_QUOTE = 5n * LAMPORTS_PER_SOL;
const MIN_WINDOW_BUY_QUOTE = 2n * LAMPORTS_PER_SOL;
const DRAWDOWN_HALT_NUM = 3_500n; // halt entries at 35% drawdown
const MAX_ORDERS_PER_BATCH = 14; // stay under the harness cap of 16
const FLOW_MAP_SOFT_CAP = 50_000;
const MIN_CURVE_TRADES = 8; // skip one-print wonders
const TRAIL_ARM_NUM = 11_500n; // trailing lock arms at +15% over cost

interface FlowCell {
  window: number;
  buyQuote: bigint;
  sellQuote: bigint;
}

const flowByMint = new Map<string, FlowCell>();
const firstHeldSlot = new Map<string, number>();
const peakValueByMint = new Map<string, bigint>();
let equityPeak = 0n;

function windowOf(slot: number): number {
  return Math.floor(slot / WINDOW_SLOTS);
}

function noteTrade(mint: string, isBuy: boolean, solAmount: bigint, slot: number): void {
  const w = windowOf(slot);
  let cell = flowByMint.get(mint);
  if (cell === undefined || cell.window !== w) {
    cell = { window: w, buyQuote: 0n, sellQuote: 0n };
    flowByMint.set(mint, cell);
  }
  if (isBuy) cell.buyQuote += solAmount;
  else cell.sellQuote += solAmount;
}

function pruneFlow(currentWindow: number): void {
  if (flowByMint.size <= FLOW_MAP_SOFT_CAP) return;
  for (const [mint, cell] of flowByMint) {
    if (cell.window < currentWindow - 1) flowByMint.delete(mint);
  }
}

function holdingValue(state: BotState, mint: string, tokenAmount: bigint): bigint | null {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.virtual_token_reserves === 0n) return null;
  return (tokenAmount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

function pendingMints(state: BotState, side: 'buy' | 'sell'): Set<string> {
  const mints = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === side) mints.add(p.order.mint);
  }
  return mints;
}

// Decide whether one held position closes on this batch. The peak value
// seen since entry drives a trailing lock: once a position has traded at
// +15% over cost or better, it closes as soon as it gives back two thirds
// of that peak gain, so a burst that fades banks most of its profit
// instead of riding all the way down to the stop-loss.
function shouldExit(state: BotState, mint: string, pos: Holding, value: bigint): boolean {
  const scaledValue = value * SCALE;
  if (scaledValue >= pos.cost_lamports * TAKE_PROFIT_NUM) return true;
  if (scaledValue <= pos.cost_lamports * STOP_LOSS_NUM) return true;
  const peak = peakValueByMint.get(mint) ?? value;
  const armed = peak * SCALE >= pos.cost_lamports * TRAIL_ARM_NUM;
  if (armed && value <= pos.cost_lamports + (peak - pos.cost_lamports) / 3n) return true;
  return state.slot - (firstHeldSlot.get(mint) ?? state.slot) >= MAX_HOLD_SLOTS;
}

function planExits(state: BotState, orders: OrderInput[]): void {
  const sellsPending = pendingMints(state, 'sell');
  for (const [mint, pos] of state.positions) {
    if (!firstHeldSlot.has(mint)) firstHeldSlot.set(mint, state.slot);
    if (sellsPending.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const value = holdingValue(state, mint, pos.token_amount);
    if (value === null || pos.cost_lamports === 0n) continue;
    const peak = peakValueByMint.get(mint);
    if (peak === undefined || value > peak) peakValueByMint.set(mint, value);
    if (shouldExit(state, mint, pos, value)) {
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }
  }
  for (const mint of [...firstHeldSlot.keys()]) {
    if (!state.positions.has(mint)) {
      firstHeldSlot.delete(mint);
      peakValueByMint.delete(mint);
    }
  }
}

function equityNow(state: BotState): bigint {
  let equity = state.cash;
  for (const [mint, pos] of state.positions) {
    const value = holdingValue(state, mint, pos.token_amount);
    equity += value === null ? pos.cost_lamports : value;
  }
  return equity;
}

function planEntries(state: BotState, batch: Batch, orders: OrderInput[]): void {
  const equity = equityNow(state);
  if (equity > equityPeak) equityPeak = equity;
  if (equityPeak > 0n && (equityPeak - equity) * SCALE > equityPeak * DRAWDOWN_HALT_NUM) return;

  let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
  if (openSlots <= 0) return;

  const buysPending = pendingMints(state, 'buy');
  const tradedThisBatch = new Set<string>();
  for (const e of batch.events) {
    if (e.event === 'TradeEvent') tradedThisBatch.add(e.mint);
  }

  const currentWindow = windowOf(state.slot);
  const candidates: { mint: string; buyQuote: bigint }[] = [];
  for (const mint of tradedThisBatch) {
    if (state.positions.has(mint) || buysPending.has(mint)) continue;
    const cell = flowByMint.get(mint);
    if (cell === undefined || cell.window < currentWindow - 1) continue;
    if (cell.buyQuote < MIN_WINDOW_BUY_QUOTE) continue;
    if (cell.buyQuote < cell.sellQuote * 2n) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.trades < MIN_CURVE_TRADES) continue;
    if (curve.created_slot === null || state.slot - curve.created_slot < MIN_AGE_SLOTS) continue;
    if (curve.real_quote_reserves < MIN_REAL_QUOTE) continue;
    candidates.push({ mint, buyQuote: cell.buyQuote });
  }
  candidates.sort((a, b) => {
    if (a.buyQuote !== b.buyQuote) return a.buyQuote > b.buyQuote ? -1 : 1;
    return a.mint < b.mint ? -1 : 1;
  });

  const txFee = state.txFeeLamports();
  for (const cand of candidates) {
    if (openSlots <= 0 || orders.length >= MAX_ORDERS_PER_BATCH) break;
    const cap = state.maxBuyLamports(cand.mint);
    const size = TICKET_LAMPORTS < cap ? TICKET_LAMPORTS : cap;
    if (size < ROUND_TRIP_FLOOR) continue;
    if (state.freeCashLamports() < size + txFee * 2n) break;
    orders.push({ side: 'buy', mint: cand.mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
    openSlots -= 1;
  }
}

await runBot({
  onHello(state) {
    equityPeak = BigInt(state.hello.capital.lamports);
    console.error(`hello: capital ${state.hello.capital.lamports}, seed ${state.hello.seed}`);
  },
  onBatch(state, batch) {
    for (const e of batch.events) {
      if (e.event === 'TradeEvent') noteTrade(e.mint, e.is_buy, BigInt(e.sol_amount), state.slot);
    }
    pruneFlow(windowOf(state.slot));
    const orders: OrderInput[] = [];
    planExits(state, orders);
    planEntries(state, batch, orders);
    return orders;
  },
  onDone(state, done) {
    console.error(`done: ${done.reason}, final cash ${state.cash}`);
  },
});
