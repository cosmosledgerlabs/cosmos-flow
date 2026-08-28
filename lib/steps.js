/**
 * lib/steps.js  —— v2
 *
 * Definitions for the three flow steps and the compensating action for each.
 *
 * Changed in v2:
 *   Step 1 Approve      - still a Memo transaction (this step is a record by nature)
 *   Step 2 Vesting      - real SPL token transfer: owner account -> escrow account
 *   Step 3 Distribution - real SPL token transfer: escrow account -> recipient
 *
 * Compensation:
 *   Step 2 compensate - escrow -> owner (a real transfer back)
 *   Step 1 compensate - Memo revocation record
 *   Step 3 is the final step and needs no compensation of its own
 *
 * orchestrator.js is unchanged.
 *
 * Terminology: never say "rollback".
 *    An on-chain transaction cannot be undone. We compensate: a new transaction
 */

import { toBaseUnits } from './spl';

// Official Solana Memo program address (same on all clusters)
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
 * @param authority  Owner of the source account (PublicKey)
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
 * The three step definitions.
 *
 * Signature of execute / compensate:
 *   (web3, pubkey, ctx) => { tx, extraSigners }
 *
 * ctx carries: flowId, amount, accounts (from SETUP), spl (the module)
 */
export const STEPS = [
  {
    id: 'approve',
    label: 'APPROVE',
    labelZh: 'Approve',
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
    labelZh: 'Vesting setup',
    description: 'Move the allocation into the escrow account. Real SPL token transfer.',

    // Owner account -> escrow, signed by the connected wallet
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

    // Escrow -> owner account, signed by the escrow keypair
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
    labelZh: 'Distribution',
    description: 'Release the allocation to the recipient. Real SPL token transfer.',

    // Escrow -> recipient, signed by the escrow keypair
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

    // Final step. When it fails the earlier steps are compensated; it needs none itself.
    compensate: null,
  },
];

/**
 * Generate a flow ID, written into the memo so one run can be traced on an explorer.
 */
export function newFlowId() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${t}-${r}`;
}
