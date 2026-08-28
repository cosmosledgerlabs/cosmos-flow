import { useState } from 'react'
import Head from 'next/head'
import Nav from '../components/Nav'
import Footer from '../components/Footer'
import { STEPS, newFlowId } from '../lib/steps'
import { runFlow, initSteps, STATUS, FLOW_STATE, readableError } from '../lib/orchestrator'
import { runSetup, readBalance, FLOW_AMOUNT, INITIAL_SUPPLY } from '../lib/spl'
import styles from '../styles/Flow.module.css'

const CLUSTER = 'devnet'
const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.devnet.solana.com'
const EXPLORER = 'https://solscan.io'

const STATUS_LABEL = {
  [STATUS.PENDING]: 'PENDING',
  [STATUS.RUNNING]: 'RUNNING',
  [STATUS.SUCCESS]: 'SUCCESS',
  [STATUS.FAILED]: 'FAILED',
  [STATUS.COMPENSATING]: 'COMPENSATING',
  [STATUS.COMPENSATED]: 'COMPENSATED',
  [STATUS.SKIPPED]: 'NOT RUN',
}

const STATUS_CLASS = {
  [STATUS.PENDING]: 'pending',
  [STATUS.RUNNING]: 'running',
  [STATUS.SUCCESS]: 'success',
  [STATUS.FAILED]: 'failed',
  [STATUS.COMPENSATING]: 'running',
  [STATUS.COMPENSATED]: 'compensated',
  [STATUS.SKIPPED]: 'skipped',
}

export default function FlowPage() {
  const [wallet, setWallet] = useState(null)
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState(initSteps(STEPS))
  const [flowState, setFlowState] = useState(FLOW_STATE.IDLE)
  const [flowId, setFlowId] = useState(null)
  const [failAt, setFailAt] = useState(0)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const [accounts, setAccounts] = useState(null)
  const [setupSigs, setSetupSigs] = useState([])
  const [balances, setBalances] = useState(null)
  const [runHistory, setRunHistory] = useState([])

  function getProvider() {
    if (typeof window === 'undefined') return null
    if (window.phantom && window.phantom.solana && window.phantom.solana.isPhantom) {
      return window.phantom.solana
    }
    if (window.solana && window.solana.isPhantom) return window.solana
    return null
  }

  function say(text, error) {
    setMessage(text)
    setIsError(Boolean(error))
  }

  async function connect() {
    const provider = getProvider()
    if (!provider) {
      say('No Phantom wallet detected. Install the Phantom extension and switch it to Devnet.', true)
      return
    }
    try {
      const res = await provider.connect()
      setWallet(res.publicKey.toString())
      say('Wallet connected. Make sure Phantom is set to Devnet.', false)
    } catch (e) {
      say('Connection cancelled.', true)
    }
  }

  async function disconnect() {
    const provider = getProvider()
    if (provider) { try { await provider.disconnect() } catch (e) {} }
    setWallet(null)
    setAccounts(null)
    setSetupSigs([])
    setBalances(null)
    reset()
  }

  // Read all three account balances and return a snapshot
  async function snapshotBalances(acc) {
    if (!acc) return null
    try {
      const web3 = await import('@solana/web3.js')
      const connection = new web3.Connection(RPC, 'confirmed')
      const [a, b, c] = await Promise.all([
        readBalance(web3, connection, acc.ownerAta),
        readBalance(web3, connection, acc.escrowAta),
        readBalance(web3, connection, acc.recipientAta),
      ])
      return { owner: a, escrow: b, recipient: c }
    } catch (e) {
      return null
    }
  }

  // Export every run in this session as a text file - no copying signatures by hand
  function exportLog() {
    if (runHistory.length === 0) return

    const L = []
    L.push('COSMOS Flow v2 — Run Log')
    L.push('Network: Solana devnet')
    L.push('Wallet: ' + wallet)
    if (accounts) {
      L.push('Mint: ' + accounts.mint)
      L.push('Owner account: ' + accounts.ownerAta)
      L.push('Escrow account: ' + accounts.escrowAta)
      L.push('Recipient account: ' + accounts.recipientAta)
    }
    L.push('Exported: ' + new Date().toISOString())
    L.push('')

    runHistory.forEach((r) => {
      L.push('---')
      L.push('Run ' + String(r.run).padStart(2, '0') + ' | ' + r.time + ' | ' + r.injection)
      L.push('Flow ID: ' + r.flowId)
      L.push('Result: ' + r.outcome)
      if (r.balancesBefore) {
        L.push('Before: owner ' + r.balancesBefore.owner +
               ' / escrow ' + r.balancesBefore.escrow +
               ' / recipient ' + r.balancesBefore.recipient)
      }
      if (r.balancesAfter) {
        L.push('After:  owner ' + r.balancesAfter.owner +
               ' / escrow ' + r.balancesAfter.escrow +
               ' / recipient ' + r.balancesAfter.recipient +
               (r.balanceReturned ? '   <- returned to start' : ''))
      }
      r.steps.forEach((st, i) => {
        if (st.executed) L.push('  Step ' + (i + 1) + ' executed:    ' + st.executed)
        if (st.compensated) L.push('  Step ' + (i + 1) + ' compensated: ' + st.compensated)
        if (!st.executed && !st.compensated) L.push('  Step ' + (i + 1) + ': ' + st.status)
      })
      L.push('')
    })

    const total = runHistory.length
    const done = runHistory.filter((r) => r.outcome === FLOW_STATE.COMPLETED).length
    const comp = runHistory.filter((r) => r.outcome === FLOW_STATE.FAILED_COMPENSATED).length
    const bad = runHistory.filter((r) => r.outcome === FLOW_STATE.FAILED_INCOMPLETE).length
    const txs = runHistory.reduce((n, r) =>
      n + r.steps.filter((st) => st.executed).length +
          r.steps.filter((st) => st.compensated).length, 0)
    const kept = runHistory.filter((r) => r.balanceReturned === true).length
    const checked = runHistory.filter((r) => r.balanceReturned !== null).length

    L.push('========================================')
    L.push('SUMMARY')
    L.push('Total runs:                  ' + total)
    L.push('Completed successfully:      ' + done)
    L.push('Failed and compensated:      ' + comp)
    L.push('Compensation failures:       ' + bad)
    L.push('Total on-chain transactions: ' + txs)
    L.push('Balance integrity:           ' + kept + '/' + checked + ' runs matched the expected state')
    L.push('========================================')

    const blob = new Blob([L.join('\n')], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'cosmos-flow-run-log-' + new Date().toISOString().slice(0, 10) + '.txt'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function refreshBalances(acc) {
    if (!acc) return
    try {
      const web3 = await import('@solana/web3.js')
      const connection = new web3.Connection(RPC, 'confirmed')
      const [a, b, c] = await Promise.all([
        readBalance(web3, connection, acc.ownerAta),
        readBalance(web3, connection, acc.escrowAta),
        readBalance(web3, connection, acc.recipientAta),
      ])
      setBalances({ owner: a, escrow: b, recipient: c })
    } catch (e) {
      setBalances(null)
    }
  }

  async function doSetup() {
    const provider = getProvider()
    if (!provider || !wallet) { say('Connect a wallet first.', true); return }

    setBusy(true)
    say('Creating token and accounts — the wallet will prompt twice…', false)

    try {
      const web3 = await import('@solana/web3.js')
      const spl = await import('@solana/spl-token')
      const connection = new web3.Connection(RPC, 'confirmed')
      const owner = new web3.PublicKey(wallet)

      const balance = await connection.getBalance(owner)
      if (balance < 20000000) {
        say('Not enough Devnet SOL for setup. Request more at faucet.solana.com (setup needs about 0.02 SOL).', true)
        setBusy(false)
        return
      }

      const acc = await runSetup({
        web3, spl, connection, provider, owner,
        onNotice: (m) => say(m, false),
      })
      setAccounts(acc)
      setSetupSigs(acc.signatures)
      await refreshBalances(acc)
      say('Setup complete. ' + INITIAL_SUPPLY + ' test tokens minted to your account.', false)
    } catch (e) {
      console.error('SETUP ERROR — full object:', e)
      console.error('SETUP ERROR — message:', e && e.message)
      console.error('SETUP ERROR — logs:', e && e.logs)
      say('Setup failed: ' + (e && e.message ? e.message : readableError(e)), true)
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    setSteps(initSteps(STEPS))
    setFlowState(FLOW_STATE.IDLE)
    setFlowId(null)
    say('', false)
  }

  async function start() {
    const provider = getProvider()
    if (!provider || !wallet) { say('Connect a wallet first.', true); return }
    if (!accounts) { say('Run SETUP first — the flow moves real SPL tokens.', true); return }

    setBusy(true)
    reset()

    const id = newFlowId()
    setFlowId(id)
    say('Running…', false)

    try {
      const web3 = await import('@solana/web3.js')
      const spl = await import('@solana/spl-token')
      const connection = new web3.Connection(RPC, 'confirmed')
      const pubkey = new web3.PublicKey(wallet)

      const balance = await connection.getBalance(pubkey)
      if (balance < 5000000) {
        say('Not enough Devnet SOL for fees. Request more at faucet.solana.com and try again.', true)
        setBusy(false)
        return
      }

      // Check the token balance before transferring: stop early rather than
      // failing at step two and wasting fees
      const before = await snapshotBalances(accounts)
      if (before && Number(before.owner) < FLOW_AMOUNT) {
        say(
          'Your token account holds ' + before.owner + ', and this flow moves ' +
          FLOW_AMOUNT + '. Run SETUP again to mint a fresh allocation.',
          true
        )
        setBusy(false)
        return
      }

      const result = await runFlow({
        web3,
        connection,
        provider,
        pubkey,
        stepDefs: STEPS,
        ctx: { flowId: id, amount: FLOW_AMOUNT, accounts, spl },
        onNotice: (m) => say(m, false),
        failAt,
        onUpdate: (s, fs) => { setSteps(s); setFlowState(fs) },
      })

      const after = await snapshotBalances(accounts)
      setBalances(after)

      setRunHistory((h) => h.concat([{
        run: h.length + 1,
        flowId: id,
        time: new Date().toISOString(),
        injection: failAt === 0 ? 'NONE' : 'FAIL AT ' + failAt,
        outcome: result.flowState,
        balancesBefore: before,
        balancesAfter: after,
        balanceReturned: before && after
          ? (before.owner === after.owner &&
             before.escrow === after.escrow &&
             before.recipient === after.recipient)
          : null,
        steps: result.steps.map((st) => ({
          id: st.id,
          label: st.label,
          status: st.status,
          executed: st.signature || null,
          compensated: st.compensationSignature || null,
        })),
      }]))

      if (result.flowState === FLOW_STATE.COMPLETED) {
        say('All three steps completed. Every transaction is verifiable on Solscan.', false)
      } else if (result.flowState === FLOW_STATE.FAILED_COMPENSATED) {
        say('A step failed. Completed steps were compensated automatically — each compensation is a real on-chain transaction.', false)
      } else {
        say('A step failed and compensation did not complete. Manual intervention required.', true)
      }
    } catch (e) {
      say('Unexpected error: ' + readableError(e), true)
      setFlowState(FLOW_STATE.IDLE)
    } finally {
      setBusy(false)
    }
  }

  const short = wallet ? wallet.slice(0, 4) + '...' + wallet.slice(-4) : ''
  const txUrl = (sig) => EXPLORER + '/tx/' + sig + '?cluster=' + CLUSTER

  return (
    <>
      <Head>
        <title>Cross-Transaction Consistency Demo — COSMOS Ledger Labs</title>
        <meta name="description" content="A three-step token operation on Solana devnet with automatic on-chain compensation when a step fails. Every transaction is independently verifiable." />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="robots" content="index, follow" />
        <meta name="theme-color" content="#000005" />
        <link rel="canonical" href="https://cosmosledgerlabs.com/flow" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </Head>

      <Nav />

      <main className={styles.page}>
        <div className={styles.container}>

          <header className={styles.header}>
            <div className={styles.badge}>SOLANA DEVNET</div>
            <h1 className={styles.title}>CROSS-TRANSACTION CONSISTENCY</h1>
            <p className={styles.subtitle}>
              A token operation is not one transaction. Approval, vesting setup and
              distribution are separate transactions. Solana is atomic within a
              transaction — not across a sequence. When a later step fails, the
              earlier ones stay on-chain.
            </p>
            <p className={styles.subtitle}>
              This runs the sequence with real SPL token transfers, and on failure
              executes real on-chain compensating transactions for the steps already
              completed. Nothing is deleted — a chain cannot delete. Each compensation
              is a new, independently verifiable transaction, and the token balances
              return to where they started.
            </p>
          </header>

          {/* ---------- controls ---------- */}
          <section className={styles.panel}>
            <div className={styles.controlRow}>
              <div className={styles.controlLabel}>WALLET</div>
              <div className={styles.controlBody}>
                {wallet ? (
                  <button className={styles.btnGhost} onClick={disconnect}>{short}</button>
                ) : (
                  <button className={styles.btn} onClick={connect}>CONNECT</button>
                )}
              </div>
            </div>

            <div className={styles.divider} />

            <div className={styles.controlRow}>
              <div className={styles.controlLabel}>SETUP</div>
              <div className={styles.controlBody}>
                {accounts ? (
                  <button className={styles.btnGhost} onClick={doSetup} disabled={busy}>
                    RE-RUN SETUP
                  </button>
                ) : (
                  <button className={styles.btn} onClick={doSetup} disabled={!wallet || busy}>
                    RUN SETUP
                  </button>
                )}
                <div className={styles.controlHint}>
                  Creates a test SPL token, mints {INITIAL_SUPPLY} to your account,
                  and opens an escrow and a recipient account. Two wallet prompts.
                  Needed once before running the flow.
                </div>
              </div>
            </div>

            <div className={styles.divider} />

            <div className={styles.controlRow}>
              <div className={styles.controlLabel}>FAILURE INJECTION</div>
              <div className={styles.controlBody}>
                <div className={styles.segmented}>
                  {[
                    { v: 0, t: 'NONE' },
                    { v: 1, t: 'FAIL AT 1' },
                    { v: 2, t: 'FAIL AT 2' },
                    { v: 3, t: 'FAIL AT 3' },
                  ].map((o) => (
                    <button
                      key={o.v}
                      className={failAt === o.v ? styles.segOn : styles.segOff}
                      onClick={() => setFailAt(o.v)}
                      disabled={busy}
                    >
                      {o.t}
                    </button>
                  ))}
                </div>
                <div className={styles.controlHint}>
                  Force a step to fail, to demonstrate compensation.
                </div>
              </div>
            </div>

            <div className={styles.divider} />

            <div className={styles.controlRow}>
              <div className={styles.controlLabel}>RUN</div>
              <div className={styles.controlBody}>
                <button
                  className={styles.btn}
                  onClick={start}
                  disabled={!wallet || busy}
                >
                  {busy ? 'RUNNING…' : 'EXECUTE FLOW'}
                </button>
                {flowId ? (
                  <div className={styles.controlHint}>Flow ID: {flowId}</div>
                ) : null}
              </div>
            </div>

            {runHistory.length > 0 ? (
              <>
                <div className={styles.divider} />
                <div className={styles.controlRow}>
                  <div className={styles.controlLabel}>RUN LOG</div>
                  <div className={styles.controlBody}>
                    <button className={styles.btnGhost} onClick={exportLog} disabled={busy}>
                      DOWNLOAD LOG ({runHistory.length})
                    </button>
                    <div className={styles.controlHint}>
                      Every run in this session, with signatures, balances and a summary.
                      Downloads as a text file. Cleared if the page is refreshed.
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {message ? (
              <div className={isError ? styles.msgError : styles.msgOk}>{message}</div>
            ) : null}
          </section>

          {/* ---------- accounts and balances ---------- */}
          {accounts ? (
            <section className={styles.verify}>
              <h2 className={styles.verifyTitle}>TOKEN ACCOUNTS</h2>
              <p className={styles.verifyIntro}>
                Real SPL token accounts on Solana devnet. Balances update after every run.
                Each flow moves {FLOW_AMOUNT} tokens.
              </p>

              <div className={styles.verifyRow}>
                <span className={styles.verifyKey}>Mint</span>
                <span className={styles.verifyVal}>{accounts.mint}</span>
                <a className={styles.verifyBtn}
                   href={EXPLORER + '/token/' + accounts.mint + '?cluster=' + CLUSTER}
                   target="_blank" rel="noopener noreferrer">VIEW</a>
              </div>

              <div className={styles.verifyRow}>
                <span className={styles.verifyKey}>
                  Your account{balances ? ' — ' + balances.owner : ''}
                </span>
                <span className={styles.verifyVal}>{accounts.ownerAta}</span>
                <a className={styles.verifyBtn}
                   href={EXPLORER + '/account/' + accounts.ownerAta + '?cluster=' + CLUSTER}
                   target="_blank" rel="noopener noreferrer">VIEW</a>
              </div>

              <div className={styles.verifyRow}>
                <span className={styles.verifyKey}>
                  Escrow{balances ? ' — ' + balances.escrow : ''}
                </span>
                <span className={styles.verifyVal}>{accounts.escrowAta}</span>
                <a className={styles.verifyBtn}
                   href={EXPLORER + '/account/' + accounts.escrowAta + '?cluster=' + CLUSTER}
                   target="_blank" rel="noopener noreferrer">VIEW</a>
              </div>

              <div className={styles.verifyRow}>
                <span className={styles.verifyKey}>
                  Recipient{balances ? ' — ' + balances.recipient : ''}
                </span>
                <span className={styles.verifyVal}>{accounts.recipientAta}</span>
                <a className={styles.verifyBtn}
                   href={EXPLORER + '/account/' + accounts.recipientAta + '?cluster=' + CLUSTER}
                   target="_blank" rel="noopener noreferrer">VIEW</a>
              </div>

              {setupSigs.map((s2) => (
                <div key={s2.signature} className={styles.verifyRow}>
                  <span className={styles.verifyKey}>{s2.label}</span>
                  <span className={styles.verifyVal}>{s2.signature}</span>
                  <a className={styles.verifyBtn} href={txUrl(s2.signature)}
                     target="_blank" rel="noopener noreferrer">VIEW</a>
                </div>
              ))}
            </section>
          ) : null}

          {/* ---------- steps ---------- */}
          <section className={styles.steps}>
            {steps.map((s, i) => (
              <div key={s.id} className={`${styles.step} ${styles[STATUS_CLASS[s.status]]}`}>
                <div className={styles.stepHead}>
                  <span className={styles.stepIndex}>{'0' + (i + 1)}</span>
                  <span className={styles.stepName}>{s.label}</span>
                  <span className={styles.stepStatus}>{STATUS_LABEL[s.status]}</span>
                </div>

                <div className={styles.stepDesc}>{s.description}</div>

                {s.signature ? (
                  <div className={styles.txRow}>
                    <span className={styles.txLabel}>EXECUTED</span>
                    <span className={styles.txHash}>{s.signature}</span>
                    <a className={styles.txLink} href={txUrl(s.signature)} target="_blank" rel="noopener noreferrer">VERIFY</a>
                  </div>
                ) : null}

                {s.compensationSignature ? (
                  <div className={styles.txRow}>
                    <span className={styles.txLabelComp}>COMPENSATED</span>
                    <span className={styles.txHash}>{s.compensationSignature}</span>
                    <a className={styles.txLink} href={txUrl(s.compensationSignature)} target="_blank" rel="noopener noreferrer">VERIFY</a>
                  </div>
                ) : null}

                {s.error ? (
                  <div className={styles.stepError}>{s.error}</div>
                ) : null}
              </div>
            ))}
          </section>

          {/* ---------- outcome ---------- */}
          {flowState === FLOW_STATE.COMPLETED ? (
            <div className={styles.outcomeOk}>
              <strong>FLOW COMPLETED</strong> — all three steps executed successfully.
            </div>
          ) : null}

          {flowState === FLOW_STATE.FAILED_COMPENSATED ? (
            <div className={styles.outcomeComp}>
              <strong>FAILED AND COMPENSATED</strong> — a step failed; every completed
              step was compensated by a real on-chain transaction, in reverse order.
              The final state matches the starting state. The transaction history does
              not disappear, and it should not: it is the audit trail.
            </div>
          ) : null}

          {flowState === FLOW_STATE.FAILED_INCOMPLETE ? (
            <div className={styles.outcomeBad}>
              <strong>COMPENSATION INCOMPLETE</strong> — a compensating transaction did
              not confirm. Manual intervention is required. This state is surfaced
              rather than hidden.
            </div>
          ) : null}

          <p className={styles.disclaimer}>
            Devnet is a public test network. Tokens on Devnet have no monetary value.
            The escrow account in this demonstration is held by a keypair generated in
            the browser — sufficient to show funds genuinely leaving and returning, but
            not a trustless escrow. A production version would use a program-derived
            address. This demonstration does not constitute an offer to sell or a
            solicitation to buy any security or digital asset.
          </p>

        </div>
      </main>

      <Footer />
    </>
  )
}
