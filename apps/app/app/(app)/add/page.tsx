'use client';

import { useEffect, useState } from 'react';
import { Done, QuoteRows } from '@/components/confirm';
import { useClient } from '@/components/session';
import {
  AmountInput,
  amountState,
  CopyButton,
  PageHead,
  ProblemNote,
  Qr,
  Sheet,
  useAction,
  useLoad,
} from '@/components/ui';
import type { FeeQuote } from '@/lib/client';
import { amountToInput, formatAmount } from '@/lib/amount';
import { solscanAccount, solscanTx } from '@/lib/format';

export default function AddMoney() {
  const client = useClient();
  const address = client.address();
  const wallet = useLoad(() => client.walletUsdc(), [client]);
  const [input, setInput] = useState('');
  const { parsed, problem } = amountState(input);
  const amount = parsed.ok ? parsed.value : null;
  const [quote, setQuote] = useState<{ amount: bigint; q: FeeQuote } | null>(null);
  const quoting = useAction();
  const [confirming, setConfirming] = useState(false);
  const deposit = useAction();
  const [done, setDone] = useState<{ txSig: string | null; net: bigint } | null>(null);

  // Quote as they type, a beat after they stop.
  useEffect(() => {
    if (amount === null) {
      setQuote(null);
      return;
    }
    const t = setTimeout(() => {
      void quoting.run(async () => setQuote({ amount, q: await client.quote(amount) }));
    }, 350);
    return () => clearTimeout(t);
  }, [amount, client]);

  const q = quote && quote.amount === amount ? quote.q : null;
  const overWallet = amount !== null && wallet.data != null && amount > wallet.data;
  const tooSmall = q !== null && q.net <= 0n;

  return (
    <>
      <PageHead
        title="Add money"
        lede="Send USDC on Solana to your deposit address, then move it into your private balance."
      />

      <section className="panel-flat stack">
        <p className="num-label" style={{ margin: 0 }}>
          1 · Your deposit address (Solana)
        </p>
        <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
          <Qr value={address} label="QR code of your deposit address" />
          <div className="stack-sm min0" style={{ flex: '1 1 240px' }}>
            <span className="address">{address}</span>
            <div className="row">
              <CopyButton value={address} label="Copy address" />
              <a
                href={solscanAccount(address)}
                className="tlink"
                target="_blank"
                rel="noopener noreferrer"
              >
                View on Solscan
              </a>
            </div>
          </div>
        </div>
        <p className="notice warn">
          <strong>USDC on Solana only.</strong> Other tokens or networks sent here can’t be
          recovered. What lands here is plain USDC, visible on-chain like any wallet, until you move
          it into your private balance.
        </p>
      </section>

      <section className="panel-flat stack section">
        <div className="spread">
          <p className="num-label" style={{ margin: 0 }}>
            2 · Move into your private balance
          </p>
          <span className="muted small mono">
            {wallet.loading
              ? 'Reading wallet…'
              : wallet.data != null
                ? `In wallet: ${formatAmount(wallet.data)} USDC`
                : null}
          </span>
        </div>
        {wallet.data === null && (
          <p className="help">
            Check how much has arrived in your wallet app or on{' '}
            <a href={solscanAccount(address)} target="_blank" rel="noopener noreferrer">
              Solscan
            </a>
            .
          </p>
        )}
        <AmountInput
          id="deposit-amount"
          label="Amount"
          value={input}
          onChange={setInput}
          {...(wallet.data ? { onMax: () => setInput(amountToInput(wallet.data!)) } : {})}
        />
        {problem && <p className="field-error">{problem}</p>}
        {overWallet && <p className="field-error">That’s more than your wallet holds.</p>}
        {tooSmall && <p className="field-error">That amount is smaller than the fee.</p>}
        {q && amount !== null && !tooSmall && (
          <QuoteRows amount={amount} quote={q} netLabel="Lands in your private balance" />
        )}
        <ProblemNote problem={quoting.error} />
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={!q || amount === null || overWallet || tooSmall}
          onClick={() => {
            deposit.setError(null);
            setDone(null);
            setConfirming(true);
          }}
        >
          Review
        </button>
      </section>

      {confirming && amount !== null && q && (
        <Sheet
          title={done ? 'Added' : 'Move into private balance'}
          onClose={() => setConfirming(false)}
          dismissable={!deposit.busy}
        >
          {done ? (
            <Done title={`${formatAmount(done.net)} USDC is now private.`}>
              {done.txSig && (
                <a
                  href={solscanTx(done.txSig)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tlink"
                >
                  View the deposit on Solscan
                </a>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setConfirming(false);
                  setInput('');
                  wallet.reload();
                }}
              >
                Close
              </button>
            </Done>
          ) : (
            <>
              <QuoteRows amount={amount} quote={q} netLabel="Lands in your private balance" />
              <p className="help">
                The deposit itself is public on Solana, like any USDC transfer. From then on your
                balance is encrypted.
              </p>
              <ProblemNote problem={deposit.error} />
              <div className="sheet-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled={deposit.busy}
                  aria-busy={deposit.busy}
                  onClick={() =>
                    void deposit.run(async () => {
                      const r = await client.deposit(amount);
                      setDone({ txSig: r.txSig, net: r.net });
                    })
                  }
                >
                  {deposit.busy ? 'Proving and confirming…' : `Move ${formatAmount(amount)} USDC`}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={deposit.busy}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </Sheet>
      )}
    </>
  );
}
