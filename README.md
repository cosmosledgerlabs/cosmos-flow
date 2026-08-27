# COSMOS Flow

Cross-transaction consistency for multi-step token operations on Solana.

Live demo: https://cosmosledgerlabs.com/flow

## The problem

Token issuance is not one transaction. Approval, vesting setup and
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

**Token balances return to their starting state.** That is visible on the
page and verifiable on-chain.

## The flow

| Step | Operation | Compensation |
|---|---|---|
| 1 · Approve | On-chain approval record | Revocation record |
| 2 · Vesting setup | SPL transfer: owner → escrow | SPL transfer: escrow → owner |
| 3 · Distribution | SPL transfer: escrow → recipient | — (final step) |

## Try it

1. Install Phantom, switch to **Devnet**
2. Get test SOL at faucet.solana.com — 0.02 SOL in the wallet is enough
3. Open https://cosmosledgerlabs.com/flow, connect, click **RUN SETUP**
   (one wallet prompt; the page creates a test token, mints 1,000,000 to
   your account and opens an escrow and a recipient account)
4. Set FAILURE INJECTION to **FAIL AT 3**, run the flow
5. Watch the balances return to their starting state
6. Click VERIFY on any transaction — it resolves on Solscan (devnet)

## Verified run

Flow ID: MTBS0DVS-BA1W
Date: 2026-08-28 (Solana devnet)
Mint: `6rn21mvqWa1p8pQnHYRGT2Zip9pS1osWf7VJ6X7hbTh1`

| Step | Action | Signature |
|---|---|---|
| 1 · Approve | Executed | [5zs93cXg…soJ8Wp](https://solscan.io/tx/5zs93cXgkQoGopTh9ap2yYuHwE8PFCor2zaqoWgPGv6bQVqSELE8HkqsWAXBZtsxvsA3TW6o3BiBkexAmjsoJ8Wp?cluster=devnet) |
| 1 · Approve | Compensated | [3qR4WxrT…KZ3sAf](https://solscan.io/tx/3qR4WxrT3H9fk8F5GtQzUnpuLtpoKJcymmB17Qjbxwsaz2XdM4cjxkhXsN5CnHn5FKPiFuibTn7JeFGEmJKZ3sAf?cluster=devnet) |
| 2 · Vesting | Executed | [MFwpwhsw…iDqREM](https://solscan.io/tx/MFwpwhswNxzGRBBrTRm9toRh2Mez51LJKZ66g62btuCGyazYXFFLKAanchbAJBj9rmAVfp873ewveVc5xiDqREM?cluster=devnet) |
| 2 · Vesting | Compensated | [LndZNwnB…9KKpLv](https://solscan.io/tx/LndZNwnBvHUM53juXzHQHkep5iBbgcwHcsM42ZdHQEAemwPuCxmMXTmaaaa7eqARYUvGZxhTfPELRYtTq9KKpLv?cluster=devnet) |
| 3 · Distribution | Failed (injected) | — |

Balances before: owner 999000 / escrow 0 / recipient 1000
Balances after:  owner 999000 / escrow 0 / recipient 1000

The step-2 compensation is a 1,000-token transfer from the escrow account
back to the owner's account, signed by the escrow keypair — see the Solscan
link above.

**Total runs recorded: 23** on this mint (7 completed, 16 with an injected
failure). Balances ended at the expected values in every run; after each of
the 7 FAIL AT 3 runs the escrow balance returned to zero. Full log with all
61 transaction links: [`run-log-v2.txt`](./run-log-v2.txt).

## Structure

| File | Purpose |
|---|---|
| `lib/steps.js` | Step definitions and their compensating actions |
| `lib/orchestrator.js` | State machine and compensation engine |
| `lib/spl.js` | SPL token setup and helpers |
| `pages/flow.js` | Interface |
| `styles/Flow.module.css` | Styling |

## On the escrow account

The escrow account in this demonstration is held by a keypair generated in
the browser and kept in page state. The same keypair is the test token's
mint authority and pays for the setup transactions (it is funded by a devnet
faucet request, or by a small transfer from the connected wallet if the
faucet declines). That is sufficient to show funds genuinely leaving and
returning, but it is **not a trustless escrow**. A production version would
use a program-derived address held by an on-chain program.

## Notes

Devnet only. Devnet tokens have no monetary value. This is a demonstration
and does not constitute an offer to sell or a solicitation to buy any
security or digital asset.

---

COSMOS Ledger Labs Inc. · Ontario, Canada · cosmosledgerlabs.com
