/**
 * lib/spl.js  — v2
 *
 * Helpers for real SPL token operations.
 *
 * One-time SETUP creates:
 *   1. a test token (mint)
 *   2. a token account for the connected wallet, minted with the initial supply
 *   3. an escrow account, owned by a keypair generated in the browser
 *   4. a recipient account
 *
 * The three flow steps then move real tokens:
 *   Step 1  Approve        → memo record
 *   Step 2  Vesting setup  → owner account → escrow account
 *   Step 3  Distribution   → escrow account → recipient account
 *
 * Compensation:
 *   Step 2 compensation → escrow account → owner account (a real transfer back)
 *   Step 1 compensation → memo record
 *
 * About the escrow account — state this honestly:
 * The escrow in this demonstration is owned by a keypair generated in the
 * browser and held in page state. That is enough to show funds genuinely
 * leaving and returning, but it is NOT a trustless escrow. A production
 * version would use a program-derived address held by an on-chain program.
 * Never describe this as "trustless escrow".
 *
 * All transactions go through sendAndConfirm in orchestrator.js, so SETUP
 * gets the same fresh-block-reference / re-broadcast / 429 back-off handling
 * as the flow steps. The setup keypair is also the mint authority.
 */

import { sendAndConfirm, rpc } from './orchestrator';

export const DECIMALS = 6;
export const INITIAL_SUPPLY = 1_000_000;   // minted to the connected wallet at SETUP
export const FLOW_AMOUNT = 1_000;          // amount moved by each flow run

/**
 * Convert a human-readable amount to on-chain base units.
 */
export function toBaseUnits(amount, decimals = DECIMALS) {
  return BigInt(Math.round(amount * Math.pow(10, decimals)));
}

/**
 * One-time SETUP: create the token and accounts, and mint the initial supply.
 *
 * Why the wallet only signs a SOL transfer:
 * Phantom simulates every transaction before it lets the user confirm, and
 * for a token-creation transaction that simulation can take longer than a
 * block reference stays valid (~60 s). So the wallet signs one plain SOL
 * transfer to a setup keypair generated in the browser, and the page signs
 * the token/account transactions itself with that keypair — no wallet delay.
 *
 * Three transactions (the wallet prompts ONCE, for the first):
 *   TX 0: wallet → setup keypair, SETUP_FUNDING SOL (wallet signs)
 *   TX A: create mint + initialise it + create the owner token account + mint
 *         (setup keypair signs; owner receives the tokens)
 *   TX B: create the escrow token account + the recipient token account
 *         (setup keypair signs)
 *
 * The setup keypair doubles as the escrow owner and the mint authority.
 * It lives only in page state (see the note above).
 *
 * @returns {Promise<{mint, ownerAta, escrow, escrowAta, recipient, recipientAta, escrowKeypair, signatures}>}
 */
export const SETUP_FUNDING_SOL = 0.01;   // covers mint rent + three token accounts + fees

/**
 * Run one setup step and prefix any error with the step's name, so a
 * failure says which of the three transactions it was.
 */
async function labelled(name, fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const err = new Error(name + ': ' + msg);
    err.cause = e;
    throw err;
  }
}

export async function runSetup({ web3, spl, connection, provider, owner }) {
  const signatures = [];

  // Fresh keypairs: the mint, the setup/escrow keypair, the recipient
  const mintKeypair = web3.Keypair.generate();
  const escrowKeypair = web3.Keypair.generate();
  const recipientKeypair = web3.Keypair.generate();

  const payer = escrowKeypair.publicKey;
  const mint = mintKeypair.publicKey;
  const ownerAta = spl.getAssociatedTokenAddressSync(mint, owner);
  const escrowAta = spl.getAssociatedTokenAddressSync(mint, payer);
  const recipientAta = spl.getAssociatedTokenAddressSync(mint, recipientKeypair.publicKey);

  // A "provider" that signs with the setup keypair instead of the wallet,
  // so the same sendAndConfirm engine handles TX A and TX B.
  const localSigner = {
    signTransaction: async (tx) => { tx.partialSign(escrowKeypair); return tx; },
  };

  // ---------- TX 0: fund the setup keypair (wallet signs) ----------
  const buildTx0 = () => {
    const tx = new web3.Transaction();
    tx.add(
      web3.SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: payer,
        lamports: Math.round(SETUP_FUNDING_SOL * web3.LAMPORTS_PER_SOL),
      })
    );
    return { tx, extraSigners: [] };
  };

  const sig0 = await labelled('SETUP TX0 (wallet → setup keypair)', () => sendAndConfirm(web3, connection, provider, buildTx0, owner));
  signatures.push({ label: 'Setup keypair funded by wallet', signature: sig0 });

  const rent = await rpc(() => spl.getMinimumBalanceForRentExemptMint(connection));

  // ---------- TX A: token + owner account + mint (setup keypair signs) ----------
  const buildTxA = () => {
    const tx = new web3.Transaction();

    tx.add(
      web3.SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mint,
        space: spl.MINT_SIZE,
        lamports: rent,
        programId: spl.TOKEN_PROGRAM_ID,
      })
    );

    tx.add(
      spl.createInitializeMintInstruction(
        mint,
        DECIMALS,
        payer,   // mint authority
        payer    // freeze authority (kept — compliance-friendly)
      )
    );

    tx.add(
      spl.createAssociatedTokenAccountInstruction(payer, ownerAta, owner, mint)
    );

    tx.add(
      spl.createMintToInstruction(
        mint,
        ownerAta,
        payer,
        toBaseUnits(INITIAL_SUPPLY)
      )
    );

    return { tx, extraSigners: [mintKeypair] };
  };

  const sigA = await labelled('SETUP TX A (create token + mint)', () => sendAndConfirm(web3, connection, localSigner, buildTxA, payer));
  signatures.push({ label: 'Token created and minted to your account', signature: sigA });

  // ---------- TX B: escrow + recipient accounts (setup keypair signs) ----------
  const buildTxB = () => {
    const tx = new web3.Transaction();

    tx.add(
      spl.createAssociatedTokenAccountInstruction(
        payer, escrowAta, payer, mint
      )
    );

    tx.add(
      spl.createAssociatedTokenAccountInstruction(
        payer, recipientAta, recipientKeypair.publicKey, mint
      )
    );

    return { tx, extraSigners: [] };
  };

  const sigB = await labelled('SETUP TX B (escrow + recipient accounts)', () => sendAndConfirm(web3, connection, localSigner, buildTxB, payer));
  signatures.push({ label: 'Escrow and recipient accounts created', signature: sigB });

  return {
    mint: mint.toString(),
    ownerAta: ownerAta.toString(),
    escrow: payer.toString(),
    escrowAta: escrowAta.toString(),
    recipient: recipientKeypair.publicKey.toString(),
    recipientAta: recipientAta.toString(),
    escrowKeypair,      // kept in page state; signs transfers out of escrow
    signatures,
  };
}

/**
 * Read a token account balance (human-readable string).
 */
export async function readBalance(web3, connection, ataString) {
  try {
    const res = await rpc(() => connection.getTokenAccountBalance(
      new web3.PublicKey(ataString)
    ));
    return res.value.uiAmountString;
  } catch (e) {
    return '0';
  }
}
