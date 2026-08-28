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
export async function runSetup({ web3, spl, connection, provider, owner, onNotice }) {
  const signatures = [];

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
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash('confirmed');

      const fresh = new web3.Transaction();
      fresh.add(...tx.instructions);
      fresh.recentBlockhash = blockhash;
      fresh.feePayer = payer;

      if (extraSigners.length > 0) {
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
