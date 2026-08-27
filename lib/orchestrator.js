/**
 * lib/orchestrator.js  — v2
 *
 * Orchestration engine: runs a sequence of steps in order and, if any step
 * fails, executes compensating transactions for the completed steps in
 * reverse order.
 *
 * Core concepts (use this wording consistently):
 *   - A single Solana transaction is atomic — that is native to the chain.
 *   - A sequence of transactions is NOT atomic — that is the gap this closes.
 *   - This is "compensation", not "rollback": a confirmed transaction cannot
 *     be undone, only offset by a new transaction.
 *
 * v2 change: a step's execute / compensate may return either a bare
 * Transaction or { tx, extraSigners }. Extra signers (e.g. the escrow
 * keypair, or a new mint keypair during SETUP) are applied with partialSign
 * before the wallet signs. The sending engine — fresh block reference per
 * attempt, re-broadcast until confirmed, 429 back-off — is unchanged.
 */

export const STATUS = {
  PENDING: 'pending',           // not started yet
  RUNNING: 'running',           // in progress
  SUCCESS: 'success',           // completed
  FAILED: 'failed',             // failed
  COMPENSATING: 'compensating', // compensation in progress
  COMPENSATED: 'compensated',   // compensation confirmed
  SKIPPED: 'skipped',           // not run because an earlier step failed
};

export const FLOW_STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED_COMPENSATED: 'failed_compensated',
  FAILED_INCOMPLETE: 'failed_incomplete', // a compensation itself failed; needs manual handling
};

/**
 * Build the initial step-state array.
 */
export function initSteps(stepDefs) {
  return stepDefs.map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    status: STATUS.PENDING,
    signature: null,
    compensationSignature: null,
    error: null,
  }));
}

/**
 * Is this a transient network error worth retrying?
 * (stale block reference, node out of sync, confirmation timeout, dropped send)
 */
function isTransient(err) {
  const text = (err && err.message ? err.message : String(err)).toLowerCase();
  if (text.indexOf('failed on-chain') !== -1) return false;
  return (
    text.indexOf('blockhash') !== -1 ||
    text.indexOf('block height') !== -1 ||
    text.indexOf('expired') !== -1 ||
    text.indexOf('timeout') !== -1 ||
    text.indexOf('timed out') !== -1 ||
    text.indexOf('failed to fetch') !== -1 ||
    text.indexOf('network') !== -1 ||
    isRateLimited(err)
  );
}

/**
 * Did the RPC node answer "429 — too many requests"?
 * The public devnet node has strict per-IP limits.
 */
function isRateLimited(err) {
  const text = (err && err.message ? err.message : String(err)).toLowerCase();
  return text.indexOf('429') !== -1 || text.indexOf('rate limit') !== -1;
}

/**
 * Call an RPC function; on a 429 wait and retry with growing delays
 * (2 s, 4 s, 8 s, 16 s) before giving up.
 */
export async function rpc(fn) {
  let delay = 2000;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e) || i >= 4) throw e;
      await sleep(delay);
      delay *= 2;
    }
  }
}

/**
 * Did the simulation reject the block reference?
 */
function isBlockhashNotFound(err) {
  const text = (err && err.message ? err.message : String(err)).toLowerCase();
  return text.indexOf('blockhash not found') !== -1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Has this signature landed on-chain (confirmed or finalized)?
 * Returns true / false, or null if the status could not be read.
 */
async function hasLanded(connection, signature) {
  try {
    const res = await rpc(() => connection.getSignatureStatuses([signature]));
    const st = res && res.value && res.value[0];
    if (!st) return false;
    if (st.err) {
      // The transaction reached the chain and FAILED there. Report that
      // plainly — it is not a timing problem and must not be retried.
      throw new Error(
        'Transaction failed on-chain: ' + JSON.stringify(st.err) +
        ' [signature ' + signature + ']'
      );
    }
    return (
      st.confirmationStatus === 'confirmed' ||
      st.confirmationStatus === 'finalized'
    );
  } catch (e) {
    if (e && e.message && e.message.indexOf('failed on-chain') !== -1) throw e;
    return null;
  }
}

/**
 * Send a signed transaction and keep re-broadcasting it every ~2 s while
 * polling its status, until it is confirmed or its block reference expires.
 * Re-broadcasting is what stops devnet from silently dropping a transaction.
 */
async function broadcastUntilConfirmed(connection, raw, signature, lastValidBlockHeight) {
  let lastSendErr = null;

  for (;;) {
    try {
      await rpc(() => connection.sendRawTransaction(raw, {
        skipPreflight: true,
        maxRetries: 0,
      }));
    } catch (e) {
      // "already processed" just means an earlier broadcast landed — fine.
      const t = (e && e.message ? e.message : String(e)).toLowerCase();
      if (t.indexOf('already been processed') === -1 &&
          t.indexOf('already processed') === -1) {
        lastSendErr = e;
      }
    }

    // Poll every 2 s for ~8 s, then re-broadcast. Gentle on the RPC node.
    for (let i = 0; i < 4; i++) {
      await sleep(2000);
      const landed = await hasLanded(connection, signature);
      if (landed === true) return signature;
    }

    const height = await rpc(() => connection.getBlockHeight('confirmed'));
    if (height > lastValidBlockHeight) {
      throw new Error(
        'Transaction expired: block height exceeded before confirmation' +
        ' [signature ' + signature + ']' +
        (lastSendErr ? ' (' + (lastSendErr.message || String(lastSendErr)) + ')' : '')
      );
    }
  }
}

/**
 * Sign, send and confirm one transaction.
 *
 * buildTx() must return a fresh Transaction on every call — either a bare
 * Transaction or { tx, extraSigners }. It is called once per attempt so a
 * retry always starts from an unsigned transaction.
 *
 * The wallet only SIGNS. The page sends the signed transaction to the same
 * RPC node that issued the block reference, and re-broadcasts until it is
 * confirmed. On a transient error the transaction is rebuilt with a fresh
 * reference and tried again, up to MAX_ATTEMPTS. Before every retry the
 * engine first checks whether the previous attempt actually landed, so no
 * step is ever sent twice. A rejection in the wallet is never retried.
 */
const MAX_ATTEMPTS = 3;

export async function sendAndConfirm(web3, connection, provider, buildTx, pubkey) {
  let lastErr = null;
  let lastSig = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (lastSig) {
        const landed = await hasLanded(connection, lastSig);
        if (landed === true) return lastSig;
      }

      const built = buildTx();
      const tx = built && built.tx ? built.tx : built;
      const extraSigners = (built && built.extraSigners) || [];

      const { blockhash, lastValidBlockHeight } =
        await rpc(() => connection.getLatestBlockhash('confirmed'));

      tx.recentBlockhash = blockhash;
      tx.feePayer = pubkey;

      // Keypairs held by the page (escrow, new mint) sign first;
      // the wallet adds the fee-payer signature after.
      if (extraSigners.length > 0) {
        tx.partialSign(...extraSigners);
      }

      let signature;

      if (typeof provider.signTransaction === 'function') {
        const signedTx = await provider.signTransaction(tx);
        const raw = signedTx.serialize();
        // First send returns the signature; later sends are re-broadcasts.
        try {
          signature = await rpc(() => connection.sendRawTransaction(raw, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 0,
          }));
        } catch (e) {
          // "Blockhash not found" from the simulation usually means the node
          // that simulated is a slot or two behind the node that issued the
          // block reference (load-balanced RPC). The reference is valid
          // on-chain, so send without simulation and let confirmation polling
          // decide — it either lands or expires, and expiry is reported.
          if (!isBlockhashNotFound(e)) throw e;
          signature = await rpc(() => connection.sendRawTransaction(raw, {
            skipPreflight: true,
            maxRetries: 0,
          }));
        }
        lastSig = signature;
        await broadcastUntilConfirmed(connection, raw, signature, lastValidBlockHeight);
      } else {
        const signed = await provider.signAndSendTransaction(tx);
        signature = signed.signature || signed;
        lastSig = signature;
        await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed'
        );
      }

      return signature;

    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === MAX_ATTEMPTS) throw err;
      await sleep(1500);
    }
  }

  throw lastErr;
}

/**
 * Run the whole flow.
 *
 * @param {object}   opts.web3        the @solana/web3.js module
 * @param {object}   opts.connection  a Connection instance
 * @param {object}   opts.provider    wallet provider (Phantom)
 * @param {object}   opts.pubkey      PublicKey of the signer
 * @param {Array}    opts.stepDefs    STEPS from steps.js
 * @param {object}   opts.ctx         context { flowId, amount, accounts, spl, ... }
 * @param {number}   opts.failAt      inject a failure at this step (1-based); 0 = no injection
 * @param {Function} opts.onUpdate    called on every state change: (steps, flowState) => void
 *
 * @returns {Promise<{flowState: string, steps: Array}>}
 */
export async function runFlow(opts) {
  const {
    web3, connection, provider, pubkey,
    stepDefs, ctx, failAt = 0, onUpdate,
  } = opts;

  const steps = initSteps(stepDefs);
  const completed = []; // indices of completed steps, compensated in reverse order

  const push = (flowState) => {
    if (onUpdate) onUpdate(steps.map((s) => ({ ...s })), flowState);
  };

  push(FLOW_STATE.RUNNING);

  // ---------- forward execution ----------
  for (let i = 0; i < stepDefs.length; i++) {
    const def = stepDefs[i];

    steps[i].status = STATUS.RUNNING;
    push(FLOW_STATE.RUNNING);

    try {
      // Injected failure: used to demonstrate the compensation mechanism
      if (failAt === i + 1) {
        throw new Error(
          'Simulated failure injected at this step (demonstration mode).'
        );
      }

      const signature = await sendAndConfirm(
        web3, connection, provider,
        () => def.execute(web3, pubkey, ctx),
        pubkey
      );

      steps[i].status = STATUS.SUCCESS;
      steps[i].signature = signature;
      completed.push(i);
      push(FLOW_STATE.RUNNING);

    } catch (err) {
      steps[i].status = STATUS.FAILED;
      steps[i].error = readableError(err);

      // Mark the remaining steps as not run
      for (let j = i + 1; j < steps.length; j++) {
        steps[j].status = STATUS.SKIPPED;
      }

      push(FLOW_STATE.RUNNING);

      // ---------- compensation in reverse order ----------
      const flowState = await compensate({
        web3, connection, provider, pubkey,
        stepDefs, steps, completed, ctx, push,
      });

      return { flowState, steps };
    }
  }

  push(FLOW_STATE.COMPLETED);
  return { flowState: FLOW_STATE.COMPLETED, steps };
}

/**
 * Compensate the completed steps, last one first.
 */
async function compensate(args) {
  const {
    web3, connection, provider, pubkey,
    stepDefs, steps, completed, ctx, push,
  } = args;

  let allCompensated = true;

  for (let k = completed.length - 1; k >= 0; k--) {
    const idx = completed[k];
    const def = stepDefs[idx];

    // This step needs no compensation
    if (!def.compensate) {
      steps[idx].status = STATUS.COMPENSATED;
      push(FLOW_STATE.RUNNING);
      continue;
    }

    steps[idx].status = STATUS.COMPENSATING;
    push(FLOW_STATE.RUNNING);

    try {
      const signature = await sendAndConfirm(
        web3, connection, provider,
        () => def.compensate(web3, pubkey, ctx),
        pubkey
      );

      steps[idx].status = STATUS.COMPENSATED;
      steps[idx].compensationSignature = signature;

    } catch (err) {
      // Compensation failed: keep SUCCESS status, record the error, flag for manual handling
      steps[idx].status = STATUS.SUCCESS;
      steps[idx].error =
        'Compensation failed — manual intervention required: ' +
        readableError(err);
      allCompensated = false;
    }

    push(FLOW_STATE.RUNNING);
  }

  const finalState = allCompensated
    ? FLOW_STATE.FAILED_COMPENSATED
    : FLOW_STATE.FAILED_INCOMPLETE;

  push(finalState);
  return finalState;
}

/**
 * Turn an error into one readable sentence.
 */
export function readableError(err) {
  const text = err && err.message ? err.message : String(err);

  if (text.indexOf('User rejected') !== -1) {
    return 'Signature was cancelled in the wallet.';
  }
  if (text.indexOf('insufficient') !== -1 ||
      text.indexOf('Insufficient') !== -1) {
    return 'Insufficient devnet SOL. Request test tokens at faucet.solana.com.';
  }
  if (isRateLimited(err)) {
    return 'The devnet RPC node is rate-limiting this computer (HTTP 429). Wait two minutes and run the flow again, or set a dedicated RPC endpoint.';
  }
  if (isTransient(err)) {
    return 'Network timing error after several attempts — please run the flow again. [' + text + ']';
  }
  return text;
}
