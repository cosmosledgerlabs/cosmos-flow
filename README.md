# COSMOS Flow

Cross-transaction consistency for multi-step token operations on Solana.

Live demo: https://cosmosledgerlabs.com/flow

## The problem

A token operation is not one transaction. Approval, vesting setup and
distribution are separate transactions with off-chain steps between them.

On Solana a single transaction is atomic — if any instruction fails, the
whole transaction is discarded. A **sequence** of transactions is not. When
step three fails, steps one and two are already on-chain and nothing unwinds
them. Teams fix it by hand.

## What this does

Runs the sequence, tracks each step, and on failure executes real on-chain
**compensating transactions** for the steps already completed, in reverse
order.

Nothing is deleted — a chain cannot delete. Each compensation is a new,
independently verifiable transaction. A failed run leaves more transactions
on-chain, not fewer. That is the audit trail, and it is the point.

**Token balances return to their starting state.** That is visible on the
page and verifiable on-chain.

## The flow

| Step | Operation | Compensation |
|---|---|---|
| 1 · Approve | On-chain approval record | Revocation record |
| 2 · Vesting setup | SPL transfer: owner → escrow | SPL transfer: escrow → owner |
| 3 · Distribution | SPL transfer: escrow → recipient | — (final step) |

## Verified runs

Solana devnet, 29 August 2026. Four runs covering every failure position.
Every signature below resolves on Solscan.

**Token accounts**

| Account | Address |
|---|---|
| Mint | `[copy from log]` |
| Owner | `[copy from log]` |
| Escrow | `[copy from log]` |
| Recipient | `[copy from log]` |

### Run 01 — no failure injected

Balances `1000000 / 0 / 0` → `999000 / 0 / 1000`

| Step | Action | Signature |
|---|---|---|
| 1 · Approve | Executed | `[copy from log]` |
| 2 · Vesting | Executed | `[copy from log]` |
| 3 · Distribution | Executed | `[copy from log]` |

### Run 02 — failure at step 3

Balances unchanged: `999000 / 0 / 1000` → `999000 / 0 / 1000`

| Step | Action | Signature |
|---|---|---|
| 1 · Approve | Executed | `[copy from log]` |
| 1 · Approve | Compensated | `[copy from log]` |
| 2 · Vesting | Executed | `[copy from log]` |
| 2 · Vesting | Compensated | `[copy from log]` |
| 3 · Distribution | Failed (injected) | — |

Step two moved 1000 tokens into escrow. Step three failed. The compensating
transaction moved them back out. Escrow returned to zero, and four
transactions remain on-chain as the record.

### Run 03 — failure at step 2

Balances unchanged. Two transactions.

| Step | Action | Signature |
|---|---|---|
| 1 · Approve | Executed | `[copy from log]` |
| 1 · Approve | Compensated | `[copy from log]` |
| 2 · Vesting | Failed (injected) | — |
| 3 · Distribution | Not run | — |

No tokens moved: step two is the transfer, and it never executed. Step one
was still compensated, because it had completed.

### Run 04 — failure at step 1

Balances unchanged. **Zero transactions.**

| Step | Action | Signature |
|---|---|---|
| 1 · Approve | Failed (injected) | — |
| 2 · Vesting | Not run | — |
| 3 · Distribution | Not run | — |

No compensation was executed, because no step had completed. Compensating
here would be incorrect behaviour, not thoroughness.

### Summary

| | |
|---|---|
| Total runs | 4 |
| Completed successfully | 1 |
| Failed and compensated | 3 |
| Compensation failures | 0 |
| Balance integrity | 4/4 runs matched the expected state |

## Try it

1. Install Phantom, switch to **Devnet**
2. Get test SOL at faucet.solana.com — setup needs about 0.02 SOL
3. Open https://cosmosledgerlabs.com/flow, connect, click **RUN SETUP**
4. Set FAILURE INJECTION to **FAIL AT 3**, run the flow
5. Watch the balances return to their starting state
6. Click VERIFY on any transaction — it resolves on Solscan (devnet)

## Structure

| File | Purpose |
|---|---|
| `lib/steps.js` | Step definitions and their compensating actions |
| `lib/orchestrator.js` | State machine and compensation engine |
| `lib/spl.js` | SPL token setup and helpers |
| `pages/flow.js` | Interface |
| `styles/Flow.module.css` | Styling |

## Reliability handling

Devnet is unreliable enough that the following were necessary to get a run to
complete end to end. Each is a response to a failure observed in testing, not
a precaution:

- **Retry on expiry.** A blockhash is valid for roughly 60 seconds. Slow
  approval or network congestion exceeds that. Retries up to three times.
- **Confirm before resending.** Before a retry, the signature status is
  polled for ten seconds. A transaction that landed but was not yet indexed
  would otherwise be sent twice — duplicating a transfer and destroying the
  balance evidence.
- **Priority fee.** Validators drop fee-less transactions under load, and
  with preflight skipped that drop is silent.
- **Rebroadcast while waiting.** The same signed bytes are resent every five
  seconds. Same blockhash, same signature, so the cluster treats it as one
  transaction. Idempotent by construction.
- **Polling confirmation.** `confirmTransaction` aborts the moment block
  height passes, discarding runs that confirm a second late.

## When compensation itself fails

The flow enters `FAILED_INCOMPLETE` and says so on the page:

> COMPENSATION INCOMPLETE — a compensating transaction did not confirm.
> Manual intervention is required. This state is surfaced rather than hidden.

This was observed during development, not just designed for. A state where
funds are stranded must be visible, not swallowed.

## On the escrow account

The escrow account in this demonstration is held by a keypair generated in
the browser. That is sufficient to show funds genuinely leaving and
returning, but it is **not a trustless escrow**. A production version would
use a program-derived address held by an on-chain program.

## Status

v2. Steps two and three are real SPL token transfers.

Next: on-chain state via PDAs, persistent execution records, and retry
handling at the protocol layer rather than the client.

## Notes

Devnet only. Devnet tokens have no monetary value. This is a demonstration
and does not constitute an offer to sell or a solicitation to buy any
security or digital asset.

---

COSMOS Ledger Labs Inc. · Ontario, Canada · cosmosledgerlabs.com
