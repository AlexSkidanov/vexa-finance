'use client';

import { useId, useState } from 'react';
import type { CalcMode } from '@/lib/fees';
import { calculate } from '@/lib/fees';

const MODES: { id: CalcMode; label: string }[] = [
  { id: 'deposit', label: 'Deposit or withdraw' },
  { id: 'stealth', label: 'Stealth transfer' },
];

export function FeeCalculator() {
  const [mode, setMode] = useState<CalcMode>('deposit');
  const [amount, setAmount] = useState('1,000');
  const [tier, setTier] = useState(0);
  const id = useId();
  const r = calculate(mode, amount, tier);

  return (
    <div
      data-reveal="1"
      data-delay="120"
      className="box"
      style={{ padding: 'clamp(22px,3vw,36px)' }}
    >
      <div className="num-label" style={{ marginBottom: 22 }} id={`${id}-t`}>
        Fee calculator
      </div>
      <div
        role="group"
        aria-label="Mode"
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 22 }}
      >
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className="seg"
            aria-pressed={mode === m.id}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <label className="field-label" htmlFor={`${id}-amt`}>
        Amount (USDC)
      </label>
      <input
        id={`${id}-amt`}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        className="input input-amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))}
      />
      <div className="field-label" style={{ margin: '20px 0 8px' }} id={`${id}-tier`}>
        Your tier
      </div>
      <div
        role="group"
        aria-labelledby={`${id}-tier`}
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <button
            key={i}
            type="button"
            className="seg mono"
            aria-pressed={tier === i}
            onClick={() => setTier(i)}
          >
            Tier {i}
          </button>
        ))}
      </div>
      <div
        aria-live="polite"
        style={{
          marginTop: 26,
          display: 'grid',
          gap: 12,
          font: '400 17px/1.3 var(--sans)',
          color: 'var(--body)',
        }}
      >
        {r.lines.map((l) => (
          <div
            key={l.k}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
              borderTop: '1px solid var(--hair)',
              paddingTop: 12,
            }}
          >
            <span>{l.k}</span>
            <span
              style={{
                font: '400 16px/1.3 var(--mono)',
                color: 'var(--paper)',
                textAlign: 'right',
              }}
            >
              {l.v}
            </span>
          </div>
        ))}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            borderTop: '1px solid var(--paper)',
            paddingTop: 14,
            alignItems: 'baseline',
          }}
        >
          <span style={{ font: '500 20px/1.2 var(--sans)', color: 'var(--paper)' }}>
            {r.totalLabel}
          </span>
          <span
            style={{
              font: '300 clamp(26px,2.6vw,34px)/1 var(--mono)',
              color: 'var(--signal)',
              letterSpacing: '-.02em',
              textAlign: 'right',
            }}
          >
            {r.total}
          </span>
        </div>
      </div>
    </div>
  );
}
