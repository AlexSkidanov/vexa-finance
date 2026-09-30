'use client';

import { useEffect, useState } from 'react';
import type { TransferStatus } from '@/lib/client';
import { describeError, type Problem } from '@/lib/errors';
import { solscanTx } from '@/lib/format';
import { STEALTH_STEPS, stealthPollDelay, stealthView } from '@/lib/stealth';
import { useClient } from './session';
import { ProblemNote, Steps, type StepState } from './ui';

/** Follows a stealth transfer through the Zcash route until it settles or comes back. */
export function StealthTracker({ id }: { id: string }) {
  const client = useClient();
  const [status, setStatus] = useState<TransferStatus | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  useEffect(() => {
    let live = true;
    let timer = 0;
    let attempt = 0;
    const poll = async () => {
      try {
        const s = await client.transferStatus(id);
        if (!live) return;
        setStatus(s);
        setProblem(null);
        if (stealthView(s.stealth?.status).terminal) return;
        timer = window.setTimeout(poll, stealthPollDelay(s.stealth?.status, attempt++));
      } catch (e) {
        if (!live) return;
        setProblem(describeError(e));
        timer = window.setTimeout(poll, 15_000);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, id]);

  const view = stealthView(status?.stealth?.status);
  const stateOf = (i: number): StepState => {
    if (view.phase === 'done') return 'done';
    if (view.phase === 'active')
      return i < view.step ? 'done' : i === view.step ? 'active' : 'todo';
    // Refunds and failures stop where the route went wrong.
    return i < view.step ? 'done' : i === view.step ? 'error' : 'todo';
  };

  return (
    <div className="stack" aria-live="polite">
      <div>
        <p className="num-label" style={{ margin: 0 }}>
          Stealth route
        </p>
        <p className="step-label" style={{ fontSize: 22, color: 'var(--paper)' }}>
          {status ? view.title : 'Checking…'}
        </p>
        <p className="help">{view.message}</p>
      </div>
      <Steps
        steps={STEALTH_STEPS.map((s, i) => ({
          label: s.label,
          state: stateOf(i),
          ...(i === view.step && view.phase === 'active' ? { detail: s.detail } : {}),
        }))}
      />
      {status?.txSig && (
        <a
          href={solscanTx(status.txSig)}
          target="_blank"
          rel="noopener noreferrer"
          className="tlink"
        >
          Final payment on Solscan
        </a>
      )}
      {!view.terminal && (
        <p className="help">
          Usually 10 to 30 minutes. You can leave this page; it’s in your activity.
        </p>
      )}
      <ProblemNote problem={problem} />
    </div>
  );
}
