import { useState } from 'react'
import Head from 'next/head'
import Nav from '../components/Nav'
import Footer from '../components/Footer'
import { STEPS, newFlowId } from '../lib/steps'
import { runFlow, initSteps, STATUS, FLOW_STATE, readableError } from '../lib/orchestrator'
import styles from '../styles/Flow.module.css'

const CLUSTER = 'devnet'
// Public devnet node by default. To use a dedicated node (recommended — the
// public one rate-limits), set NEXT_PUBLIC_SOLANA_RPC in Vercel → Settings →
// Environment Variables and redeploy. No code change needed.
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
    reset()
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

    setBusy(true)
    reset()

    const id = newFlowId()
    setFlowId(id)
    say('Running…', false)

    try {
      const web3 = await import('@solana/web3.js')
      const connection = new web3.Connection(RPC, 'confirmed')
      const pubkey = new web3.PublicKey(wallet)

      const balance = await connection.getBalance(pubkey, 'confirmed')
      if (balance <= 0) {
        say('This wallet holds no Devnet SOL. Request test tokens at faucet.solana.com and try again.', true)
        setBusy(false)
        return
      }

      const result = await runFlow({
        web3,
        connection,
        provider,
        pubkey,
        stepDefs: STEPS,
        ctx: { flowId: id, amount: '1000' },
        failAt,
        onUpdate: (s, fs) => { setSteps(s); setFlowState(fs) },
      })

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
              This runs the sequence, and on failure executes real on-chain
              compensating transactions for the steps already completed. Nothing is
              deleted — a chain cannot delete. Each compensation is a new,
              independently verifiable transaction.
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

            {message ? (
              <div className={isError ? styles.msgError : styles.msgOk}>{message}</div>
            ) : null}
          </section>

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
            This demonstration does not constitute an offer to sell or a solicitation
            to buy any security or digital asset.
          </p>

        </div>
      </main>

      <Footer />
    </>
  )
}
