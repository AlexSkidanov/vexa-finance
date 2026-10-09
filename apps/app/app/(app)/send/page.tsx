'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Done } from '@/components/confirm';
import { Amount } from '@/components/money';
import { useClient } from '@/components/session';
import { StealthTracker } from '@/components/stealth-tracker';
import {
  AmountInput,
  amountState,
  newIdempotencyKey,
  PageHead,
  ProblemNote,
  Row,
  Sheet,
  useAction,
  useLoad,
} from '@/components/ui';
import type { HandleResolution } from '@/lib/client';
import { amountToInput, formatAmount } from '@/lib/amount';
import { describeError, type Problem } from '@/lib/errors';
import { solscanTx } from '@/lib/format';
import { classifyRecipient } from '@/lib/handles';
import { STEALTH_MINIMUM, stealthFeeEstimate } from '@/lib/stealth';

type Mode = 'standard' | 'stealth';

export default function Send() {
  const client = useClient();
  const balance = useLoad(() => client.balance(), [client]);
  const [to, setTo] = useState('');
  const [input, setInput] = useState('');
  const [memo, setMemo] = useState('');
  const [mode, setMode] = useState<Mode>('standard');
  const recipient = classifyRecipient(to);
  const [resolved, setResolved] = useState<
    { key: string; r: HandleResolution } | { key: string; problem: Problem } | null
  >(null);
  const { parsed, problem } = amountState(input);
  const amount = parsed.ok ? parsed.value : null;
  const [vaultFee, setVaultFee] = useState<{ amount: bigint; fee: bigint } | null>(null);
  const [sheet, setSheet] = useState<{ key: string } | null>(null);
  const send = useAction();
  const [sent, setSent] = useState<{ id: string; txSig: string | null; mode: Mode } | null>(null);

  const handleKey = recipient.kind === 'handle' ? recipient.handle : '';
  useEffect(() => {
    if (!handleKey) return;
    const t = setTimeout(() => {
      client.resolve(handleKey).then(
        (r) => setResolved({ key: handleKey, r }),
        (e: unknown) => setResolved({ key: handleKey, problem: describeError(e) }),
      );
    }, 350);
    return () => clearTimeout(t);
  }, [handleKey, client]);
  const match = resolved && resolved.key === handleKey ? resolved : null;
  const who = match && 'r' in match ? match.r : null;

  // The vault fee, for the stealth estimate.
  useEffect(() => {
    if (mode !== 'stealth' || amount === null) return;
    const t = setTimeout(() => {
      client.quote(amount).then(
        (q) => setVaultFee({ amount, fee: q.fee }),
        () => setVaultFee(null),
      );
    }, 350);
    return () => clearTimeout(t);
  }, [mode, amount, client]);

  const b = balance.data;
  const spendable = b ? (mode === 'stealth' ? b.available : b.available + b.pending) : null;
  const over = amount !== null && spendable !== null && amount > spendable;
  const needsApply =
    mode === 'stealth' &&
    amount !== null &&
    b &&
    amount > b.available &&
    amount <= b.available + b.pending;
  const underStealthMin = mode === 'stealth' && amount !== null && amount < STEALTH_MINIMUM;
  const estimate =
    mode === 'stealth' && amount !== null && vaultFee?.amount === amount
      ? stealthFeeEstimate(amount, vaultFee.fee)
      : null;
  const canReview = !!who && amount !== null && !over && !underStealthMin && !!b;

  const reset = () => {
    setSheet(null);
    setSent(null);
    setTo('');
    setInput('');
    setMemo('');
    balance.reload();
  };

  return (
    <>
      <PageHead
        title="Send"
        lede="To anyone with a Vexa handle. The amount and memo are encrypted on this device; only you and they can read them."
      />
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canReview) return;
          send.setError(null);
          // One key per confirmation, reused if they retry it.
          setSheet({ key: newIdempotencyKey() });
        }}
      >
        <div>
          <label className="field-label" htmlFor="to">
            To
          </label>
          <input
            id="to"
            className="input"
            placeholder="@name"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <div aria-live="polite">
            {recipient.kind === 'invalid' && <p className="field-error">{recipient.message}</p>}
            {recipient.kind === 'address' && (
              <p className="notice" style={{ marginTop: 10 }}>
                That’s a Solana address. Private transfers go to handles; to send plain USDC to a
                wallet, <Link href="/withdraw/">withdraw</Link> instead.
              </p>
            )}
            {recipient.kind === 'handle' && !match && <p className="help">Looking up…</p>}
            {who && (
              <p className="field-ok">
                {who.display}
                {who.kind === 'agent' ? ' · an agent' : ''}
              </p>
            )}
            {match && 'problem' in match && <p className="field-error">{match.problem.message}</p>}
          </div>
        </div>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">How</legend>
          <div className="row" role="group">
            <button
              type="button"
              className="seg"
              aria-pressed={mode === 'standard'}
              onClick={() => setMode('standard')}
            >
              Private
            </button>
            <button
              type="button"
              className="seg"
              aria-pressed={mode === 'stealth'}
              onClick={() => setMode('stealth')}
            >
              Stealth
            </button>
          </div>
          <p className="help">
            {mode === 'standard'
              ? 'Instant and free. The amount is hidden; Solana shows that your account paid theirs.'
              : 'No on-chain link between you and them: routed through the Zcash shielded pool. Takes 10 to 30 minutes, from 5 USDC, with bridge fees.'}
          </p>
        </fieldset>

        <AmountInput
          id="send-amount"
          label="Amount"
          value={input}
          onChange={setInput}
          {...(spendable ? { onMax: () => setInput(amountToInput(spendable)) } : {})}
        />
        <div aria-live="polite">
          {problem && <p className="field-error">{problem}</p>}
          {over && <p className="field-error">That’s more than you can send right now.</p>}
          {underStealthMin && <p className="field-error">Stealth transfers start at 5 USDC.</p>}
          {needsApply && (
            <p className="field-error">
              Part of that is still pending. Apply it on the Home screen first.
            </p>
          )}
          {b && (
            <p className="help">
              Available: <Amount units={b.available} /> USDC
              {b.pending > 0n && (
                <>
                  {' '}
                  · pending: <Amount units={b.pending} />
                  {mode === 'standard' ? ' (applied automatically)' : ''}
                </>
              )}
            </p>
          )}
          <ProblemNote problem={balance.error} onRetry={balance.reload} />
        </div>

        {mode === 'standard' && (
          <div>
            <label className="field-label" htmlFor="memo">
              Memo (optional, encrypted)
            </label>
            <input
              id="memo"
              className="input"
              maxLength={140}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
        )}

        <button className="btn btn-primary btn-lg" disabled={!canReview}>
          Review
        </button>
      </form>

      {sheet && who && amount !== null && (
        <Sheet
          title={sent ? (sent.mode === 'stealth' ? 'On its way' : 'Sent') : 'Confirm'}
          onClose={() => (sent ? reset() : setSheet(null))}
          dismissable={!send.busy}
        >
          {sent ? (
            sent.mode === 'stealth' ? (
              <div className="stack">
                <StealthTracker id={sent.id} />
                <button type="button" className="btn btn-secondary" onClick={reset}>
                  Close
                </button>
              </div>
            ) : (
              <Done title={`${formatAmount(amount)} USDC to ${who.display}`}>
                <p className="help">Settled on Solana. The amount is visible only to you two.</p>
                {sent.txSig && (
                  <a
                    href={solscanTx(sent.txSig)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="tlink"
                  >
                    View on Solscan (amount encrypted)
                  </a>
                )}
                <button type="button" className="btn btn-primary" onClick={reset}>
                  Done
                </button>
              </Done>
            )
          ) : (
            <>
              <div className="stack-sm">
                <Row k="To" v={who.display} />
                <Row k="Amount" v={`${formatAmount(amount)} USDC`} />
                <Row k="Route" v={mode === 'stealth' ? 'Stealth, via Zcash' : 'Private transfer'} />
                {mode === 'standard' && <Row k="Fee" v="Free" />}
                {mode === 'standard' && memo && <Row k="Memo" v={memo} />}
                {mode === 'stealth' && (
                  <Row
                    k="Estimated fees"
                    v={estimate !== null ? `about ${formatAmount(estimate)} USDC` : '…'}
                  />
                )}
              </div>
              {mode === 'stealth' && (
                <p className="help">
                  The vault fee twice (out and back in), about 0.6 USDC in bridge fees and about
                  0.2% in swaps. {who.display} receives what’s left, in 10 to 30 minutes. If the
                  route can’t complete, the money comes back to you.
                </p>
              )}
              <ProblemNote problem={send.error} />
              <div className="sheet-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled={send.busy}
                  aria-busy={send.busy}
                  onClick={() =>
                    void send.run(async () => {
                      const r = await client.transfer({
                        to: who.handle,
                        amount,
                        mode,
                        idempotencyKey: sheet.key,
                        ...(mode === 'standard' && memo.trim() ? { memo: memo.trim() } : {}),
                      });
                      setSent({ ...r, mode });
                    })
                  }
                >
                  {send.busy
                    ? mode === 'stealth'
                      ? 'Proving and starting the route…'
                      : 'Encrypting, proving, sending…'
                    : `Send ${formatAmount(amount)} USDC`}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={send.busy}
                  onClick={() => setSheet(null)}
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
