# COSMOS Flow

Cross-transaction consistency for multi-step token operations on Solana.

Live demo: https://cosmosledgerlabs.com/flow
Live demo source (current, runnable app): https://github.com/cosmosledgerlabs/cosmosledgerlabs-website — `pages/flow.js` and `lib/`

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
| Mint | `DGs2LTaSTUcKCYZuhnVcsvUU2nuZQxmVQmpT7yytrph1` |
| Owner | `E9Qrx2cubx4nug1VwwEB68gkyrR2JeBrD5MV26WX6bUW` |
| Escrow | `2ggjxBvGaRDmDmDtTWbhEhu3T6d5wonR2JCbBan5gTSh` |
| Recipient | `DWRHAuc9QPaSDD64FB33tHHazAkcanWH7kvzGDfNH3u8` |

### Run 01 — no failure injected

Balances `1000000 / 0 / 0` → `999000 / 0 / 1000`

| Step | Action | Signature |
|---|---|---|
| 1 · Approve | Executed | `4GYAt6sBdVUNuYyHitay5ThpnyZFkqDAUFcihiC6E22LRmgcgXePQmVR6MKnuZidmDJpTSai2rYqyqTJ2SVNFZWx` |
| 2 · Vesting | Executed | `v9veWQrFb1Ld8X1S4dX7yduVWpVRUJc7pztp6rKbKRRwwhhTZDPE73BBGmegAGztGnbmwShG5L32nsHNwFa91kt` |
| 3 · Distribution | Executed | `5oiG6ouiCCvYJDubv4M1W1iEiz963qeicp2bWZqgkK6ZEyeRrGTbrjBCyM1Ea6ph7uL24opz2LFqQDiFG6Ni7PxV` |

### Run 02 — failure at step 3

Balances unchanged: `999000 / 0 / 1000` → `999000 / 0 / 1000`

| Step | Action | Signature |
|---|---|---|
| 1 · Approve | Executed | `2ZKU6Z1WrMw2ciTEXjWoN8mBFWPsv1pKX8TRfL5yPzgN9TUxoihmGRvncFmcmeeXNa638tudE6XsHb4otQ891eMs` |
| 1 · Approve | Compensated | `3ACTJ2cPepT4kcEopjy7edyLVBe2PScaQZsgwNR2KMFWoBzZa5Mx235qdCW4WWApxsma8eg94apwUtncdjrU3DAr` |
| 2 · Vesting | Executed | `5drqaf7m61izJcs9JBCuXDm7ijTYp1NR7CPnNVR29VqrPGnRJBFo1UDhrVBcACb4rthB4CBmxkbF8kz7QtR93u3x` |
| 2 · Vesting | Compensated | `Ye8SqPdmNvsKhKAyRQ6G35MapHRzXqQSdueEtVnibYJ3a3qH6swEwFV5SpG9bUvMgtgTkgFovZMuaQHa2vaLNEu` |
| 3 · Distribution | Failed (injected) | — |

Step two moved 1000 tokens into escrow. Step three failed. The compensating
transaction moved them back out. Escrow returned to zero, and four
transactions remain on-chain as the record.

### Run 03 — failure at step 2

Balances unchanged. Two transactions.

| Step | Action | Signature |
|---|---|---|
| 1 · Approve | Executed | `McDmap44ANPNqiB9wWNEPus1uLBX6WE5iYJ7n98JQFsBcPVxKM8cJv14bSxbu23VAkfQLTgS2rnpGN83Ba11cuw` |
| 1 · Approve | Compensated | `38MqyHVLSinbzi2M48HtG1S8MTpj7j4QQ2Byu1T3nt5BLpCwQ8WRPPHhzYQpJfPWCpbcPvb5wp8oe7UZcHwvPJf3` |
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
7. Under RUN LOG, check the run summary line ends in **BALANCE CHECK: PASS**
8. Refresh the page — the run is still listed (saved in your browser)
9. Click **DOWNLOAD CSV** for a one-row-per-run spreadsheet, or **DOWNLOAD LOG** for the text record

## Structure

The files below are the engine as built in August 2026. The live page's
current version — including the hackathon additions — is `pages/flow.js` in
the website repository linked above.

| File | Purpose |
|---|---|
| `lib/steps.js` | Step definitions and their compensating actions |
| `lib/orchestrator.js` | State machine and compensation engine |
| `lib/spl.js` | SPL token setup and helpers |
| `pages/flow.js` | Interface (August version; see the website repository for the current one) |
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

## Development history

This repository is disclosed in full. Every commit is dated, and the dates
below can be checked in the commit history.

### Built before the hackathon (25–30 August 2026)

All of the following existed before the Crypto World's Fair window opened on
14 September 2026:

| Dates | Work |
|---|---|
| 25–26 Aug 2026 | v1: three-step flow using Memo transactions, orchestration engine with compensation handling, flow page and styles, first README |
| 27–28 Aug 2026 | v2: real SPL token transfers in steps 2 and 3, SPL setup helpers, balance display, 23-run test log (`run-log-v2.txt`) |
| 29–30 Aug 2026 | Run history and log export, priority fee, polling confirmation, rebroadcast and duplicate-send guard; four verified devnet runs (29 Aug) documented in this README |

The live page at cosmosledgerlabs.com/flow runs inside the company website
repository (`cosmosledgerlabs/cosmosledgerlabs-website`), which supplies the
site header, footer, bilingual text and build configuration. **The current
code of the live demo is in that repository** (`pages/flow.js`, `lib/`); this
repository keeps the original engine files from August 2026. Between 3 and
13 September 2026 — still before the window — the live page also received a
how-to-use panel, bilingual (EN / Traditional Chinese) text and layout
changes; the engine was unchanged.

### Built during the hackathon (14 September – 12 October 2026)

All of the following was committed to `cosmosledgerlabs/cosmosledgerlabs-website`
inside the competition window. Dates are commit dates and can be checked in
that repository's history.

| Date | Change |
|---|---|
| **3 Oct 2026** | **Persistent run records.** Every run is saved in the visitor's browser and survives a page refresh (previously the history was lost on refresh). A CLEAR button removes saved runs. |
| **3 Oct 2026** | **CSV report.** New DOWNLOAD CSV button: one row per run — flow ID, wallet, mint, failure injected, result, steps executed and compensated, transaction count, balances before and after, balance check, and every signature. Opens in Excel, Google Sheets or Numbers. |
| **3 Oct 2026** | **Per-run balance check.** Each run is checked against its expected end state: completed → owner down by the flow amount and recipient up by it; failed and compensated → every balance back exactly where it started. Shown as PASS / FAIL on the page, in the text log and in the CSV. This also fixes the August log summary, which counted completed runs as not matching. |
| **3 Oct 2026** | **Run summary on the page.** The last five runs are listed under the log buttons: failure injected, steps executed, steps compensated, transactions, balance check. |
| **3 Oct 2026** | "Demo updated" date line under the demo. |
| 23–24 Sep 2026 | Full-screen mode for the demo (also exits on navigation), screen wake lock for recordings and booths, auto-fitting message box. |
| 25–26 Sep 2026 | Revised wallet-connection and failure-mode instructions; revised Chinese disclaimer. |
| 18–25 Sep 2026 | Demo video embedded on the page; text-alignment fixes. |

The compensation engine itself (`lib/steps.js`, `lib/orchestrator.js`,
`lib/spl.js`) was built before the window and is disclosed above.

## Status

v2. Steps two and three are real SPL token transfers. Since 3 October 2026,
run records persist in the browser, export to CSV, and every run carries an
automatic balance check.

Next: on-chain state via PDAs, server-side execution records shared across
devices and operators, and retry handling at the protocol layer rather than
the client.

## Notes

Devnet only. Devnet tokens have no monetary value. This is a demonstration
and does not constitute an offer to sell or a solicitation to buy any
security or digital asset.

---

COSMOS Ledger Labs Inc. · Ontario, Canada · cosmosledgerlabs.com
