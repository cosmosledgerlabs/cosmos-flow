/**
 * lib/steps.js  — v2
 *
 * The three-step flow, and the compensating action for each step.
 *
 * What changed in v2:
 *   Step 1  Approve        — still a Memo transaction (this step is a record by nature)
 *   Step 2  Vesting setup  — real SPL token transfer: owner account → escrow account
 *   Step 3  Distribution   — real SPL token transfer: escrow account → recipient account
 *
 * Compensation:
 *   Step 2 compensation — escrow account → owner account (a real transfer back)
 *   Step 1 compensation — Memo revocation record
 *   Step 3 is the final step and needs no compensation of its own
 *
 * Each execute / compensate returns { tx, extraSigners }. The orchestrator
 * applies extraSigners (the escrow keypair) with partialSign before the
 * wallet signs as fee payer.
 *
 * Wording: never say "rollback". A confirmed transaction cannot be undone;
 * we "compensate" — send a new transaction that offsets the effect.
 */

import { toBaseUnits } from './spl';

// Solana's official Memo program (same address on every network)
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * Build a Memo transaction.
 */
function memoTx(web3, pubkey, text) {
  const tx = new web3.Transaction();
  tx.add(
    new web3.TransactionInstruction({
      keys: [{ pubkey: pubkey, isSigner: true, isWritable: true }],
      programId: new web3.PublicKey(MEMO_PROGRAM_ID),
      data: new TextEncoder().encode(text),
    })
  );
  return tx;
}

/**
 * Build an SPL token transfer transaction.
 *
 * @param authority  owner of the source token account (PublicKey)
 */
function transferTx(web3, spl, fromAta, toAta, authority, amount) {
  const tx = new web3.Transaction();
  tx.add(
    spl.createTransferInstruction(
      new web3.PublicKey(fromAta),
      new web3.PublicKey(toAta),
      authority,
      toBaseUnits(amount)
    )
  );
  return tx;
}

/**
 * The three-step flow.
 *
 * Signature of execute / compensate:
 *   (web3, pubkey, ctx) => { tx, extraSigners }
 *
 * ctx contains: flowId, amount, accounts (from SETUP), spl (the module)
 */
export const STEPS = [
  {
    id: 'approve',
    label: 'APPROVE',
    description: 'Record an on-chain approval for this operation.',

    execute: (web3, pubkey, ctx) => ({
      tx: memoTx(
        web3, pubkey,
        `COSMOS|flow=${ctx.flowId}|step=approve|action=grant|amount=${ctx.amount}`
      ),
      extraSigners: [],
    }),

    compensate: (web3, pubkey, ctx) => ({
      tx: memoTx(
        web3, pubkey,
        `COSMOS|flow=${ctx.flowId}|step=approve|action=revoke`
      ),
      extraSigners: [],
    }),
  },

  {
    id: 'vest',
    label: 'VESTING SETUP',
    description: 'Move the allocation into the escrow account. Real SPL token transfer.',

    // owner account → escrow account, signed by the wallet
    execute: (web3, pubkey, ctx) => ({
      tx: transferTx(
        web3, ctx.spl,
        ctx.accounts.ownerAta,
        ctx.accounts.escrowAta,
        pubkey,
        ctx.amount
      ),
      extraSigners: [],
    }),

    // escrow account → owner account, signed by the escrow keypair
    compensate: (web3, pubkey, ctx) => ({
      tx: transferTx(
        web3, ctx.spl,
        ctx.accounts.escrowAta,
        ctx.accounts.ownerAta,
        ctx.accounts.escrowKeypair.publicKey,
        ctx.amount
      ),
      extraSigners: [ctx.accounts.escrowKeypair],
    }),
  },

  {
    id: 'distribute',
    label: 'DISTRIBUTION',
    description: 'Release the allocation to the recipient. Real SPL token transfer.',

    // escrow account → recipient account, signed by the escrow keypair
    execute: (web3, pubkey, ctx) => ({
      tx: transferTx(
        web3, ctx.spl,
        ctx.accounts.escrowAta,
        ctx.accounts.recipientAta,
        ctx.accounts.escrowKeypair.publicKey,
        ctx.amount
      ),
      extraSigners: [ctx.accounts.escrowKeypair],
    }),

    // Final step. If it fails the two earlier steps are compensated;
    // it needs no compensation of its own.
    compensate: null,
  },
];

/**
 * Generate a flow ID. It is written into the memo so one flow's
 * transactions can be traced together in an explorer.
 */
export function newFlowId() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${t}-${r}`;
}
