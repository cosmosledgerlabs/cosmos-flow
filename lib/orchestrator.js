/**
 * lib/orchestrator.js
 *
 * Orchestration engine: runs steps in order and, when any step fails,
 * executes compensating transactions for the completed steps in reverse order.
 *
 * Core concepts:
 *   - A single Solana transaction is atomic (guaranteed by the chain)
 *   - A sequence of transactions is not atomic - that is the gap we address
 *   - We compensate; we do not roll back:
 *     a confirmed transaction cannot be undone, only offset by a new one
 */

export const STATUS = {
  PENDING: 'pending',           // not started
  RUNNING: 'running',           // in progress
  SUCCESS: 'success',           // completed
  FAILED: 'failed',             // failed
  COMPENSATING: 'compensating', // compensation in progress
  COMPENSATED: 'compensated',   // compensated
  SKIPPED: 'skipped',           // not run because an earlier step failed
};

export const FLOW_STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED_COMPENSATED: 'failed_compensated',
  FAILED_INCOMPLETE: 'failed_incomplete', // compensation itself failed - manual action needed
};

/**
 * Initialise the step state array.
 */
export function initSteps(stepDefs) {
  return stepDefs.map((s) => ({
    id: s.id,
    label: s.label,
    labelZh: s.labelZh,
    description: s.description,
    status: STATUS.PENDING,
    signature: null,
    compensationSignature: null,
    error: null,
  }));
}

/**
 * Submit a transaction and wait for confirmation.
 */
/**
 * Whether an error means the transaction expired.
 *
 * A Solana transaction carries a blockhash valid for roughly 60 seconds.
 * A slow wallet approval or a congested network can push it past that window.
 * These errors clear on retry - they are not real failures.
 */
function isExpiryError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return (
    msg.includes('block height exceeded') ||
    msg.includes('blockhash not found') ||
    msg.includes('transaction expired') ||
    msg.includes('timed out awaiting confirmation') ||
    msg.includes('was not confirmed')
  );
}

/**
 * Whether the user explicitly rejected the request.
 * Never retry this - the user said no.
 */
function isUserRejection(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('rejected the request')
  );
}

/**
 * Send a transaction and wait for confirmation.
 *
 * On expiry, retries up to three times with a fresh blockhash each time.
 * A user rejection is never retried.
 *
 * Before resending it checks the chain: the previous attempt may have landed
 * while the page timed out waiting. If so it returns that signature instead.
 */
async function sendAndConfirm(web3, connection, provider, tx, pubkey, extraSigners, onNotice) {
  const MAX_ATTEMPTS = 3;
  let lastSignature = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Before retrying, check whether the previous signature actually landed
    if (lastSignature) {
      // A resend must be preceded by proof the previous attempt did not land.
      //
      // A single check is not enough: a transaction can be on-chain but not yet
      // indexed. Resending in that window would duplicate the transfer, the
      // balances would not match, and the "returns to start" evidence is lost.
      //
      // So poll five times at two-second intervals (about ten seconds) first.
      let landed = false;
      for (let probe = 0; probe < 5; probe++) {
        try {
          const st = await connection.getSignatureStatus(lastSignature, {
            searchTransactionHistory: true,
          });
          const v = st && st.value;
          if (v && !v.err && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) {
            landed = true;
            break;
          }
          if (v && v.err) break;   // confirmed failure - safe to resend
        } catch (e) {
          // The status query itself failed - keep polling
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (landed) return lastSignature;

    }

    try {
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash('confirmed');

      // Each attempt needs a clean transaction object;
      // the old blockhash and signatures cannot be reused
      const fresh = new web3.Transaction();
      fresh.add(...tx.instructions);
      fresh.recentBlockhash = blockhash;
      fresh.feePayer = pubkey;

      if (extraSigners && extraSigners.length > 0) {
        fresh.partialSign(...extraSigners);
      }

      // Phantom's signAndSendTransaction is unreliable when a transaction
      // already carries partial signatures from other keypairs - it assumes it
      // is the only signer and throws a generic "Unexpected error".
      // When extra signers are present, sign and send in two steps instead so
      // those signatures survive.
      let signature;
      if (extraSigners && extraSigners.length > 0 && provider.signTransaction) {
        const signedTx = await provider.signTransaction(fresh);
        signature = await connection.sendRawTransaction(signedTx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });
      } else {
        const signed = await provider.signAndSendTransaction(fresh);
        signature = signed.signature || signed;
      }
      lastSignature = signature;

      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      return signature;
    } catch (err) {
      lastError = err;

      if (isUserRejection(err)) throw err;
      if (!isExpiryError(err)) throw err;
      if (attempt === MAX_ATTEMPTS) break;

      if (onNotice) {
        onNotice(
          'Transaction expired (attempt ' + attempt + ' of ' + MAX_ATTEMPTS +
          '). Retrying with a fresh blockhash — approve the prompt as soon as it appears.'
        );
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  throw lastError;
}

/**
 * Run the whole flow.
 *
 * @param {object}   opts.web3        the @solana/web3.js module
 * @param {object}   opts.connection  a Connection instance
 * @param {object}   opts.provider    wallet provider (Phantom)
 * @param {object}   opts.pubkey      PublicKey
 * @param {Array}    opts.stepDefs    STEPS from steps.js
 * @param {object}   opts.ctx         context { flowId, amount, ... }
 * @param {number}   opts.failAt      step to fail deliberately (1-based); 0 = no injection
 * @param {Function} opts.onUpdate    callback on state change (steps, flowState) => void
 *
 * @returns {Promise<{flowState: string, steps: Array}>}
 */
export async function runFlow(opts) {
  const {
    web3, connection, provider, pubkey,
    stepDefs, ctx, failAt = 0, onUpdate, onNotice,
  } = opts;

  const steps = initSteps(stepDefs);
  const completed = []; // indices of successful steps, for reverse-order compensation

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
      // Injected failure, used to demonstrate compensation
      if (failAt === i + 1) {
        throw new Error(
          'Simulated failure injected at this step (demonstration mode).'
        );
      }

      const built = def.execute(web3, pubkey, ctx);
      const signature = await sendAndConfirm(
        web3, connection, provider, built.tx, pubkey, built.extraSigners, onNotice
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

      // ---------- reverse-order compensation ----------
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
 * Compensate the completed steps in reverse order.
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
      const built = def.compensate(web3, pubkey, ctx);
      const signature = await sendAndConfirm(
        web3, connection, provider, built.tx, pubkey, built.extraSigners, onNotice
      );

      steps[idx].status = STATUS.COMPENSATED;
      steps[idx].compensationSignature = signature;

    } catch (err) {
      // Compensation failed: keep SUCCESS, record the error, flag manual action
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
 * Turn an error into a sentence a person can act on.
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
  if (text.indexOf('blockhash') !== -1) {
    return 'Transaction expired before confirmation. Please retry.';
  }
  return text;
}
