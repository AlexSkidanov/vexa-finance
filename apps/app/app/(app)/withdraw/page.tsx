'use client';

import { isSolanaAddress } from '@vexa/core';
import { useEffect, useState } from 'react';
import { Done, QuoteRows } from '@/components/confirm';
import { Amount } from '@/components/money';
import { useClient } from '@/components/session';
import {
  AmountInput,
  amountState,
  PageHead,
  ProblemNote,
  Row,
  Sheet,
  useAction,
  useLoad,
} from '@/components/ui';
import type { FeeQuote } from '@/lib/client';
import { amountToInput, formatAmount } from '@/lib/amount';
import { shortAddress, solscanTx } from '@/lib/format';

export default function Withdraw() {
  const client = useClient();
  const balance = useLoad(() => client.balance(), [client]);
  const [to, setTo] = useState('');
  const [input, setInput] = useState('');
  const { parsed, problem } = amountState(input);
  const amount = parsed.ok ? parsed.value : null;
  const [quote, setQuote] = useState<{ amount: bigint; q: FeeQuote } | null>(null);
  const [open, setOpen] = useState(false);
  const action = useAction();
  const [done, setDone] = useState<{ txSig: string | null; net: bigint } | null>(null);

  const dest = to.trim();
  const destOk = isSolanaAddress(dest);
  const own = destOk && dest === client.address();

  useEffect(() => {
    if (amount === null) return;
    const t = setTimeout(() => {
      client.quote(amount).then(
        (q) => setQuote({ amount, q }),
        () => setQuote(null),
      );
    }, 350);
    return () => clearTimeout(t);
  }, [amount, client]);

  const q = quote && quote.amount === amount ? quote.q : null;
  const b = balance.data;
  const over = amount !== null && b != null && amount > b.available;
  const tooSmall = q !== null && q.net <= 0n;
  const ready = destOk && !own && amount !== null && !!q && !over && !tooSmall;

  return (
    <>
      <PageHead
        title="Withdraw"
        lede="Send plain USDC to any Solana wallet or exchange. Withdrawals are public on-chain, like any USDC transfer."
      />
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          action.setError(null);
          setDone(null);
          setOpen(true);
        }}
      >
        <div>
          <label className="field-label" htmlFor="dest">
            To Solana address
          </label>
          <input
            id="dest"
            className="input"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="Wallet address"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          {dest && !destOk && <p className="field-error">That isn’t a Solana address.</p>}
          {own && (
            <p className="field-error">
              That’s your own deposit address. Withdraw to another wallet.
            </p>
          )}
          <p className="help">
            The wallet needs to hold USDC already (exchange deposit addresses do). Vexa doesn’t
            create token accounts for withdrawals.
          </p>
        </div>
        <AmountInput
          id="withdraw-amount"
          label="Amount"
          value={input}
          onChange={setInput}
          {...(b?.available ? { onMax: () => setInput(amountToInput(b.available)) } : {})}
        />
        {problem && <p className="field-error">{problem}</p>}
        {over && <p className="field-error">That’s more than your available balance.</p>}
        {tooSmall && <p className="field-error">That amount is smaller than the fee.</p>}
        {b && (
          <p className="help">
            Available: <Amount units={b.available} /> USDC
            {b.pending > 0n && ' (apply pending funds on Home to include them)'}
          </p>
        )}
        <ProblemNote problem={balance.error} onRetry={balance.reload} />
        {q && amount !== null && !tooSmall && (
          <QuoteRows amount={amount} quote={q} netLabel="They receive" />
        )}
        <button className="btn btn-primary btn-lg" disabled={!ready}>
          Review
        </button>
      </form>

      {open && amount !== null && q && (
        <Sheet
          title={done ? 'Withdrawn' : 'Confirm withdrawal'}
          onClose={() => setOpen(false)}
          dismissable={!action.busy}
        >
          {done ? (
            <Done title={`${formatAmount(done.net)} USDC sent to ${shortAddress(dest)}`}>
              {done.txSig && (
                <a
                  href={solscanTx(done.txSig)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tlink"
                >
                  View on Solscan
                </a>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setOpen(false);
                  setInput('');
                  setTo('');
                  balance.reload();
                }}
              >
                Done
              </button>
            </Done>
          ) : (
            <>
              <div className="stack-sm">
                <Row k="To" v={<span className="mono">{shortAddress(dest, 6, 6)}</span>} />
              </div>
              <div style={{ marginTop: 8 }}>
                <QuoteRows amount={amount} quote={q} netLabel="They receive" />
              </div>
              <p className="help">Check the address. Solana transfers can’t be reversed.</p>
              <ProblemNote problem={action.error} />
              <div className="sheet-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled={action.busy}
                  aria-busy={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      const r = await client.withdraw(amount, dest);
                      setDone({ txSig: r.txSig, net: r.net });
                    })
                  }
                >
                  {action.busy ? 'Proving and sending…' : `Withdraw ${formatAmount(amount)} USDC`}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={action.busy}
                  onClick={() => setOpen(false)}
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
