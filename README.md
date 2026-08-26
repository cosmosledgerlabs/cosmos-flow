# cosmos-flow

**Cross-transaction consistency for multi-step token operations on Solana.**

Live demo: https://cosmosledgerlabs.com/flow

## The problem

Token issuance is not one transaction. Approval, vesting setup, and
distribution are three separate transactions. On Solana, a single
transaction is atomic. A sequence of transactions is not.

When step three fails, steps one and two are already on-chain, and nothing
unwinds them. Teams fix it by hand.

## What this does

Runs the sequence, tracks each step, and on failure executes real on-chain
**compensating transactions** for the steps already completed, in reverse
order.

Nothing is deleted — a chain cannot delete. Each compensation is a new,
independently verifiable transaction. A failed run leaves several
transactions on-chain, not zero. That is the audit trail, and it is the point.

## Try it

1. Install Phantom, switch to **Devnet**
2. Get test SOL at faucet.solana.com
3. Open https://cosmosledgerlabs.com/flow, connect, set FAILURE INJECTION to **FAIL AT 3**, run the flow
4. Click VERIFY on any transaction — it resolves on Solscan (devnet)

## Verified transactions

Flow ID: MT7X9IP0-QICF (run 2026-08-25, FAIL AT 3)

| Step | Action | Signature |
|---|---|---|
| 1 · Approve | Executed | https://solscan.io/tx/4gpbEAsai6oMqhs5TetfkhCJf3LBsZqABptTvEfZA8cLsbSFUeDCkqSkvAWNJpknpsRCbUKgfQjqijCFZ3zjXY6U?cluster=devnet |
| 1 · Approve | Compensated | https://solscan.io/tx/5TVnZQCVX43UCtM3TJgD5ZNGuNPdoh9Ymgvgsqd1woPCxSvqJxdakJqHmVtt1isJKKkUnpTGnRy2djdTSciEApZE?cluster=devnet |
| 2 · Vesting | Executed | https://solscan.io/tx/1XZBEiiUVRdR78xeeCTQPtgri33U1Sk1EBn5sfvxscTGxBVajPESE2zuk7khACFf2QqudTrKqgfWy2zBx4F6pAS?cluster=devnet |
| 2 · Vesting | Compensated |https://solscan.io/tx/5QTFj5t8pWrf1nJQ8cTsub5gWUd57x5vPHq1Kd6uj56GyGWegjVVwx28zBELHWy7DQrcek4vwDgCbng8HhoUDeC1?cluster=devnet |
| 3 · Distribution | Failed (injected) | — |

## Structure

| File | Purpose |
|---|---|
| `lib/steps.js` | Step definitions and their compensating actions |
| `lib/orchestrator.js` | State machine and compensation engine |
| `pages/flow.js` | Interface |
| `styles/Flow.module.css` | Styling |

## Status

v1 — all three steps use Memo transactions. The goal was to get the
orchestration and compensation engine working and tested end to end.

v2, with steps two and three as real SPL token transfers, is in progress.
Only `lib/steps.js` changes; the orchestrator does not.

## Notes

Devnet only. Devnet tokens have no monetary value. This is a demonstration
and does not constitute an offer to sell or a solicitation to buy any
security or digital asset.

---

COSMOS Ledger Labs Inc. · Ontario, Canada · cosmosledgerlabs.com
