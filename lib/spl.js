/**
 * lib/spl.js
 *
 * v2 - helpers for real SPL token operations.
 *
 * SETUP runs once and creates:
 *   1. a test token (mint)
 *   2. a token account for the connected wallet, with an initial mint
 *   3. an escrow account held by a keypair generated in the browser
 *   4. a recipient account
 *
 * The three flow steps then move real tokens:
 *   Step 1 Approve      -> memo record
 *   Step 2 Vesting      -> owner account -> escrow
 *   Step 3 Distribution -> escrow -> recipient
 *
 * Compensation:
 *   Step 2 compensate -> escrow -> owner account (a real transfer back)
 *   Step 1 compensate -> memo record
 *
 * A plain statement about the escrow account:
 * It is held by a keypair generated in the browser and kept in page state.
 * That is enough to show funds genuinely leaving and returning, but it is not
 * a trustless escrow. A production version would use a program-derived address
 * held by an on-chain program. Do not describe this as a trustless escrow.
 */

export const DECIMALS = 6;
export const INITIAL_SUPPLY = 1_000_000;   // initial mint to the owner account
export const FLOW_AMOUNT = 1_000;          // amount moved by one flow run

/**
 * Convert a human-readable amount to base units.
 */
export function toBaseUnits(amount, decimals = DECIMALS) {
  return BigInt(Math.round(amount * Math.pow(10, decimals)));
}

/**
 * One-time setup: create the token and accounts, and mint the initial supply.
 *
 * Two transactions, so the wallet prompts twice:
 *   TX A: create the mint, initialise it, create the owner account, mint
 *   TX B: create the escrow and recipient accounts
 *
 * @returns {Promise<{mint, ownerAta, escrow, escrowAta, recipient, recipientAta, signatures}>}
 */
/**
 * Prepend compute budget instructions.
 *
 * Devnet validators drop transactions that carry no priority fee when the
 * network is busy. With skipPreflight enabled that drop is silent, so the run
 * simply times out with no explanation. A small priority fee makes the
 * transaction worth including.
 *
 * The cost is negligible: 200,000 compute units at 50,000 micro-lamports per
 * unit is 0.00001 SOL. On devnet the tokens have no value regardless.
 */
function withPriorityFee(web3, tx) {
  if (!web3.ComputeBudgetProgram) return tx;
  const ixs = [
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
    web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }),
  ];
  tx.instructions = ixs.concat(tx.instructions);
  return tx;
}

export async function runSetup({ web3, spl, connection, provider, owner, onNotice }) {
  const signatures = [];
  const solBalance = await connection.getBalance(owner);
  console.log('SETUP start | owner:', owner.toString(),
    '| SOL balance (lamports):', solBalance,
    '| RPC host:', (() => {
      try { return new URL(connection.rpcEndpoint).hostname; }
      catch (e) { return 'unknown'; }
    })());

  // Three keypairs: the mint, the escrow holder, the recipient
  const mintKeypair = web3.Keypair.generate();
  const escrowKeypair = web3.Keypair.generate();
  const recipientKeypair = web3.Keypair.generate();

  const mint = mintKeypair.publicKey;
  const ownerAta = spl.getAssociatedTokenAddressSync(mint, owner);
  const escrowAta = spl.getAssociatedTokenAddressSync(mint, escrowKeypair.publicKey);
  const recipientAta = spl.getAssociatedTokenAddressSync(mint, recipientKeypair.publicKey);

  // ---------- TX A ----------
  const rent = await spl.getMinimumBalanceForRentExemptMint(connection);

  const txA = new web3.Transaction();

  txA.add(
    web3.SystemProgram.createAccount({
      fromPubkey: owner,
      newAccountPubkey: mint,
      space: spl.MINT_SIZE,
      lamports: rent,
      programId: spl.TOKEN_PROGRAM_ID,
    })
  );

  txA.add(
    spl.createInitializeMintInstruction(
      mint,
      DECIMALS,
      owner,   // mint authority
      owner    // freeze authority - retained deliberately
    )
  );

  txA.add(
    spl.createAssociatedTokenAccountInstruction(owner, ownerAta, owner, mint)
  );

  txA.add(
    spl.createMintToInstruction(
      mint,
      ownerAta,
      owner,
      toBaseUnits(INITIAL_SUPPLY)
    )
  );

  console.log('SETUP TX A: creating mint', mint.toString(),
    '| instructions:', txA.instructions.length,
    '| rent lamports:', rent);

  const sigA = await sendWithExtraSigners({
    web3, connection, provider, tx: txA, payer: owner,
    extraSigners: [mintKeypair], onNotice,
  });
  signatures.push({ label: 'Token created and minted', signature: sigA });

  // ---------- TX B ----------
  const txB = new web3.Transaction();

  txB.add(
    spl.createAssociatedTokenAccountInstruction(
      owner, escrowAta, escrowKeypair.publicKey, mint
    )
  );

  txB.add(
    spl.createAssociatedTokenAccountInstruction(
      owner, recipientAta, recipientKeypair.publicKey, mint
    )
  );

  console.log('SETUP TX B: creating escrow + recipient accounts',
    '| instructions:', txB.instructions.length);

  const sigB = await sendWithExtraSigners({
    web3, connection, provider, tx: txB, payer: owner,
    extraSigners: [], onNotice,
  });
  signatures.push({ label: 'Escrow and recipient accounts created', signature: sigB });

  return {
    mint: mint.toString(),
    ownerAta: ownerAta.toString(),
    escrow: escrowKeypair.publicKey.toString(),
    escrowAta: escrowAta.toString(),
    recipient: recipientKeypair.publicKey.toString(),
    recipientAta: recipientAta.toString(),
    escrowKeypair,      // kept in page state; signs transfers out of escrow
    signatures,
  };
}

/**
 * Send a transaction, supporting signers beyond the wallet (e.g. new account keypairs).
 */
/**
 * Wait for a signature to reach confirmed or finalized status.
 *
 * connection.confirmTransaction() aborts as soon as the blockhash's
 * lastValidBlockHeight passes. In practice a transaction often lands a second
 * or two after that point, and aborting throws away a run that actually
 * succeeded. This polls the signature status instead and keeps checking for
 * the full timeout.
 *
 * Returns true if confirmed, false if the timeout elapsed with no result.
 * Throws if the chain reports the transaction itself failed.
 */
async function pollForConfirmation(connection, signature, timeoutMs, onNotice, rawTx) {
  const started = Date.now();
  const INTERVAL = 2000;
  let told = false;
  let lastRebroadcast = Date.now();

  while (Date.now() - started < timeoutMs) {
    const waited = Date.now() - started;
    if (!told && waited > 12000 && onNotice) {
      told = true;
      onNotice('Transaction sent, waiting for the network to confirm. This can take a moment.');
    }
    try {
      const st = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });
      const v = st && st.value;

      if (v) {
        if (v.err) {
          throw new Error(
            'Transaction failed on-chain: ' + JSON.stringify(v.err)
          );
        }
        if (v.confirmationStatus === 'confirmed' ||
            v.confirmationStatus === 'finalized') {
          return true;
        }
      }
    } catch (e) {
      // A chain-reported failure must propagate; a query error must not.
      if (String((e && e.message) || '').startsWith('Transaction failed on-chain')) {
        throw e;
      }
    }

    // Rebroadcast the same signed bytes every five seconds.
    //
    // Devnet drops transactions under load, and skipPreflight means a drop is
    // silent rather than immediate. Resending identical bytes is safe: same
    // blockhash, same signature, so the cluster treats it as one transaction.
    // This is idempotent - it cannot double-spend or duplicate a transfer.
    if (rawTx && Date.now() - lastRebroadcast > 5000) {
      lastRebroadcast = Date.now();
      try {
        await connection.sendRawTransaction(rawTx, {
          skipPreflight: true,
          maxRetries: 0,
        });
      } catch (e) {
        // A rebroadcast failure is not meaningful; the poll decides the outcome.
      }
    }

    await new Promise((r) => setTimeout(r, INTERVAL));
  }

  return false;
}

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

function isUserRejection(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('rejected the request')
  );
}

export async function sendWithExtraSigners({
  web3, connection, provider, tx, payer, extraSigners = [], onNotice,
}) {
  const MAX_ATTEMPTS = 3;
  let lastSignature = null;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
      // Use a confirmed blockhash for the full validity window.
      //
      // We briefly used 'finalized' to work around BlockhashNotFound, but a
      // finalized hash is ~32 slots old and burns roughly 13 of the 60 seconds
      // available before the transaction can even be signed. skipPreflight
      // below addresses the node-lag problem properly, so we take the time back.
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash('confirmed');

      const fresh = new web3.Transaction();
      fresh.add(...tx.instructions);
      withPriorityFee(web3, fresh);
      fresh.recentBlockhash = blockhash;
      fresh.feePayer = payer;

      if (extraSigners.length > 0) {
        fresh.partialSign(...extraSigners);
      }

      // Simulate first. Phantom hides the real reason behind a generic
      // "Unexpected error", so run the transaction against the chain
      // ourselves and print exactly what it rejects.
      try {
        const sim = await connection.simulateTransaction(fresh);
        console.log('SIMULATE result:', sim && sim.value);
        if (sim && sim.value && sim.value.err) {
          const simErrText = JSON.stringify(sim.value.err);

          // BlockhashNotFound here means the simulating node had not caught up,
          // not that the transaction is invalid. Do not block the send on it.
          if (simErrText.includes('BlockhashNotFound')) {
            console.warn('SIMULATE skipped: node had not seen the blockhash yet. Sending anyway.');
            throw new Error('__SIM_SKIP__');
          }

          console.error('SIMULATE FAILED — err:', simErrText);
          console.error('SIMULATE FAILED — logs:', sim.value.logs);
          const detail = (sim.value.logs || []).slice(-4).join(' | ');
          throw new Error(
            'Transaction rejected by the network: ' +
            JSON.stringify(sim.value.err) + (detail ? ' — ' + detail : '')
          );
        }
      } catch (simErr) {
        const m = String((simErr && simErr.message) || '');
        // A real program rejection must stop us.
        if (m.startsWith('Transaction rejected')) throw simErr;
        // Node lag or a simulation that could not run must not.
        if (m !== '__SIM_SKIP__') console.warn('SIMULATE could not run:', simErr);
      }

      // Phantom's signAndSendTransaction is unreliable when a transaction
      // already carries partial signatures from other keypairs - it assumes it
      // is the only signer and throws a generic "Unexpected error".
      // When extra signers are present, sign and send in two steps instead so
      // those signatures survive.
      let signature;
      let rawBytes = null;
      // Evidence from the console: TX A (which used signTransaction) succeeded,
      // TX B (which used signAndSendTransaction) failed with Phantom's generic
      // "Unexpected error". So prefer signTransaction whenever the wallet
      // offers it, regardless of extra signers. signAndSendTransaction is now
      // only a fallback for wallets that lack signTransaction.
      if (provider.signTransaction) {
        console.log('SIGNING PATH: signTransaction + sendRawTransaction | extraSigners =', extraSigners ? extraSigners.length : 0);
        const signedTx = await provider.signTransaction(fresh);
        // skipPreflight: true is deliberate.
        //
        // We already ran simulateTransaction above, so the RPC's own preflight
        // adds nothing. Worse, preflight runs on whichever node handles the
        // send request, and behind a load balancer that node may not have seen
        // our blockhash yet - which surfaced as "Blockhash not found" even
        // though our own simulation passed on the same transaction.
        //
        // Skipping preflight sends the transaction to the cluster and lets
        // confirmTransaction decide the outcome. A genuinely bad transaction
        // is still caught by our simulation beforehand.
        rawBytes = signedTx.serialize();
        signature = await connection.sendRawTransaction(rawBytes, {
          skipPreflight: true,
          maxRetries: 3,
        });
      } else {
        console.log('SIGNING PATH: signAndSendTransaction, extraSigners =',
          extraSigners ? extraSigners.length : 0,
          'signTransaction available =', !!provider.signTransaction);
        const signed = await provider.signAndSendTransaction(fresh);
        signature = signed.signature || signed;
      }
      lastSignature = signature;

      // Poll for confirmation instead of using connection.confirmTransaction.
      //
      // confirmTransaction stops the moment the block height passes, even when
      // the transaction is queued and about to land. Polling the signature
      // status keeps checking for a further grace period, which recovers the
      // common case of a transaction confirming a second or two late.
      const confirmed = await pollForConfirmation(
        connection, signature, 45000, onNotice, rawBytes
      );
      if (!confirmed) {
        throw new Error('Transaction expired: not confirmed in time');
      }

      return signature;
    } catch (err) {
      lastError = err;
      if (isUserRejection(err)) throw err;

      // Account already exists = the previous attempt landed but was not detected.
      // Not a failure, but this transaction must not be resent.
      const m = String((err && err.message) || err || '').toLowerCase();
      if (m.includes('already in use')) {
        throw new Error(
          'This setup transaction already landed on-chain. Refresh the page and run SETUP once more to start from a clean state.'
        );
      }

      if (!isExpiryError(err)) throw err;
      if (attempt === MAX_ATTEMPTS) break;

      if (onNotice) {
        onNotice(
          'Setup transaction expired (attempt ' + attempt + ' of ' + MAX_ATTEMPTS +
          '). Retrying — approve the prompt as soon as it appears.'
        );
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  throw lastError;
}

/**
 * Read a token account balance in human-readable form.
 */
export async function readBalance(web3, connection, ataString) {
  try {
    const res = await connection.getTokenAccountBalance(
      new web3.PublicKey(ataString)
    );
    return res.value.uiAmountString;
  } catch (e) {
    return '0';
  }
}
