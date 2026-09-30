'use client';

import { useEffect, useState } from 'react';
import { formatUsdc2 } from '@/lib/format';
import type { Transparency } from '@/lib/live';
import { getTransparency } from '@/lib/live';
import { Decrypt } from './decrypt';
import { TLink } from './transition';

type State = { kind: 'loading' } | { kind: 'ok'; data: Transparency } | { kind: 'error' };

/** Reserve USDC and cUSDC supply, read live from Solana through the API. */
export function LiveReserve({ variant }: { variant: 'home' | 'security' }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    void getTransparency().then((data) => {
      if (live) setState(data ? { kind: 'ok', data } : { kind: 'error' });
    });
    return () => {
      live = false;
    };
  }, []);

  const reserve = state.kind === 'ok' ? formatUsdc2(state.data.reserve) : null;
  const supply = state.kind === 'ok' ? formatUsdc2(state.data.supply) : null;
  const pending = state.kind === 'loading' ? '▒▒▒▒▒▒▒▒▒▒' : '—';
  const failed = state.kind === 'error' && (
    <p className="muted-caption" role="status">
      Couldn&rsquo;t reach Solana right now.
    </p>
  );

  return (
    <div data-reveal="1" className="strip">
      <div className="min0">
        <div className="strip-label">USDC in reserve</div>
        <Decrypt text={reserve} fallback={pending} className="strip-num" />
      </div>
      <div className="min0">
        <div className="strip-label">cUSDC supply</div>
        <Decrypt text={supply} fallback={pending} className="strip-num" />
      </div>
      {variant === 'home' ? (
        <div
          className="min0"
          style={{ font: '400 17px/1.45 var(--sans)', color: 'var(--body)', textWrap: 'pretty' }}
        >
          Both numbers are public on Solana and must match.{' '}
          <TLink href="/security/" className="inline-link">
            Verify them on the Security page.
          </TLink>
          {failed}
        </div>
      ) : state.kind === 'ok' ? (
        state.data.match ? (
          <div className="chip chip-signal" style={{ alignSelf: 'end', justifySelf: 'start' }}>
            <span className="dot blink" />
            Match · read from Solana
          </div>
        ) : (
          <div className="chip chip-warn" style={{ alignSelf: 'end', justifySelf: 'start' }}>
            <span className="dot dot-paper" />
            Mismatch · read from Solana
          </div>
        )
      ) : (
        <div className="min0" style={{ alignSelf: 'end' }}>
          {failed || (
            <div className="chip" style={{ color: 'var(--ash)' }}>
              <span className="dot dot-moss" />
              Reading from Solana…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
