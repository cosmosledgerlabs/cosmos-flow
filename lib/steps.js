/**
 * lib/steps.js
 *
 * Definitions of the three-step flow and the compensating action for each step.
 *
 * v1 note:
 * All three steps use Memo transactions (the official Solana SPL Memo program).
 * The goal of v1 is to get the orchestration and compensation engine working
 * and tested end to end.
 * v2 will replace STEP 2 / STEP 3 with real SPL token operations. Only the
 * execute / compensate functions in this file change; orchestrator.js stays as is.
 *
 * Terminology: do not call this "rollback". On-chain transactions cannot be
 * undone. What we do is "compensation" — a new transaction that offsets the
 * effect of an earlier one.
 */

// Official Solana Memo program address (same on every network)
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * Build a Memo transaction.
 * @param {object} web3   the @solana/web3.js module
 * @param {object} pubkey the signer's public key
 * @param {string} text   the text written on-chain
 */
function buildMemoTransaction(web3, pubkey, text) {
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
 * The three-step flow.
 *
 * Each step has:
 *   id           internal identifier
 *   label        name shown in the interface
 *   description  explanation shown in the interface
 *   execute      forward action, returns a transaction
 *   compensate   compensating action, returns a transaction; null = no compensation needed
 */
export const STEPS = [
  {
    id: 'approve',
    label: 'APPROVE',
    description: 'Record an on-chain approval for this operation.',

    execute: (web3, pubkey, ctx) =>
      buildMemoTransaction(
        web3,
        pubkey,
        `COSMOS|flow=${ctx.flowId}|step=approve|action=grant`
      ),

    compensate: (web3, pubkey, ctx) =>
      buildMemoTransaction(
        web3,
        pubkey,
        `COSMOS|flow=${ctx.flowId}|step=approve|action=revoke`
      ),
  },

  {
    id: 'vest',
    label: 'VESTING SETUP',
    description: 'Lock the allocation into a vesting arrangement.',

    // v2: replace with an SPL Token transfer (main account → escrow account)
    execute: (web3, pubkey, ctx) =>
      buildMemoTransaction(
        web3,
        pubkey,
        `COSMOS|flow=${ctx.flowId}|step=vest|action=lock|amount=${ctx.amount}`
      ),

    // v2: replace with an SPL Token transfer (escrow account → main account)
    compensate: (web3, pubkey, ctx) =>
      buildMemoTransaction(
        web3,
        pubkey,
        `COSMOS|flow=${ctx.flowId}|step=vest|action=unlock|amount=${ctx.amount}`
      ),
  },

  {
    id: 'distribute',
    label: 'DISTRIBUTION',
    description: 'Release the allocation to the recipient.',

    // v2: replace with an SPL Token transfer (escrow account → recipient)
    execute: (web3, pubkey, ctx) =>
      buildMemoTransaction(
        web3,
        pubkey,
        `COSMOS|flow=${ctx.flowId}|step=distribute|action=release|amount=${ctx.amount}`
      ),

    // Final step. If it fails, the two earlier steps are compensated;
    // this step itself never needs compensation.
    compensate: null,
  },
];

/**
 * Generate a flow ID. It is written into every memo so one flow's
 * transactions can be traced together on a block explorer.
 */
export function newFlowId() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${t}-${r}`;
}
