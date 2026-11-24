# Pulse Five — Pump.fun Paper Sprint bot

[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/haidildariell/pumpfun-paper-sprint-v2/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/haidildariell/pumpfun-paper-sprint-v2/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A momentum-rotation paper-trading bot for the make.fun bounty
[Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).

## Strategy

- Watches trade flow in fixed 25-slot windows. When a young, liquid curve
  prints a burst of buy flow (buy quote at least twice the sell quote and
  at least 2 SOL in the window), the bot opens a fixed 0.05 SOL ticket.
- At most five open positions at once. Each position closes on a +25%
  take-profit, a -20% stop-loss, or after 4.000 slots held.
- New entries halt after a 35% drawdown from the equity peak; exits always
  stay live.

## Built for the grader

- One pass over each batch's events plus a scan of the held positions, so
  the run finishes fast and well inside the wall budget.
- Fully deterministic: no clock, no environment reads, no Math.random —
  the two graded executions produce byte-identical order logs.
- Runs on Node 22 as-is (`node main.ts`); the only other file it needs is
  the kit's own protocol shim in `vendor/makefun-bot.ts`.

## Layout

- `main.ts` — the strategy (entrypoint).
- `vendor/makefun-bot.ts` — the agent-fun/replay/v2 bot shim from the
  competition kit.
- `LICENSE` — MIT.
