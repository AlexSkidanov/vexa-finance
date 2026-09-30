'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { encode } from 'uqr';
import { AMOUNT_PROBLEMS, cleanAmountInput, parseAmount, type AmountParse } from '@/lib/amount';
import { describeError, type Problem } from '@/lib/errors';
import { Icon } from './icons';
import { useSession } from './session';

/**
 * Loads data for a screen. Errors become a readable Problem; an expired
 * session signs out instead.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const { signOut } = useSession();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let live = true;
    setLoading(true);
    fnRef.current().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        const p = describeError(e);
        if (p.signedOut) signOut('expired');
        setError(p);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [tick, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/** Runs one action at a time, tracking busy and error state. */
export function useAction() {
  const { signOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn();
      } catch (e) {
        const p = describeError(e);
        if (p.signedOut) signOut('expired');
        setError(p);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [signOut],
  );
  return { busy, error, run, setError };
}

export function PageHead({
  title,
  lede,
  back,
  eyebrow,
  children,
}: {
  title: string;
  lede?: ReactNode;
  back?: { href: string; label: string };
  eyebrow?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      {back && (
        <Link href={back.href} className="back">
          <span style={{ width: 16, height: 16, display: 'inline-flex' }}>
            <Icon.back />
          </span>
          {back.label}
        </Link>
      )}
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <div className="spread" style={{ alignItems: 'flex-end' }}>
        <h1 className="page-title">{title}</h1>
        {children}
      </div>
      {lede && <p className="page-lede">{lede}</p>}
    </header>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" />
      {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ProblemNote({
  problem,
  onRetry,
}: {
  problem: Problem | null;
  onRetry?: () => void;
}) {
  if (!problem) return null;
  return (
    <div className="problem" role="alert">
      {problem.message}
      {onRetry && problem.retryable && (
        <>
          {' '}
          <button type="button" className="max-btn" onClick={onRetry} style={{ marginLeft: 6 }}>
            Try again
          </button>
        </>
      )}
      {problem.requestId && <span className="req">Request {problem.requestId}</span>}
    </div>
  );
}

export function Sheet({
  title,
  onClose,
  children,
  dismissable = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** False while something is in flight. */
  dismissable?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  // Handlers change every render; the effect below must run only once.
  const latest = useRef({ onClose, dismissable });
  latest.current = { onClose, dismissable };
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && latest.current.dismissable) latest.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, []);
  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissable) onClose();
      }}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        ref={ref}
      >
        <h2 className="sheet-title" id={id}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        });
      }}
    >
      {copied ? <Icon.check /> : <Icon.copy />}
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </button>
  );
}

/** A secret with a copy button and a warning; shown once unless `warning` says otherwise. */
export function OnceSecret({
  value,
  what,
  warning,
}: {
  value: string;
  what: string;
  warning?: ReactNode;
}) {
  return (
    <div className="stack-sm">
      <code className="secret">{value}</code>
      <div className="row">
        <CopyButton value={value} />
      </div>
      <p className="notice warn">
        {warning ?? (
          <>
            <strong>Copy it now.</strong> This is the only time Vexa shows this {what}. Anyone who
            has it can use it, so keep it somewhere safe.
          </>
        )}
      </p>
    </div>
  );
}

export type StepState = 'todo' | 'active' | 'done' | 'error';

export function Steps({
  steps,
}: {
  steps: { label: string; state: StepState; detail?: ReactNode }[];
}) {
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={s.label} className="step" data-state={s.state}>
          <span className="step-dot" aria-hidden="true">
            {s.state === 'done' ? '✓' : s.state === 'error' ? '!' : i + 1}
          </span>
          <div>
            <div className="step-label">
              {s.label}
              <span className="sr-only">
                {s.state === 'done'
                  ? ' (done)'
                  : s.state === 'active'
                    ? ' (in progress)'
                    : s.state === 'error'
                      ? ' (failed)'
                      : ''}
              </span>
            </div>
            {s.detail && <div className="step-detail">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** An amount field that only accepts up to six decimals, with an optional Max. */
export function AmountInput({
  id,
  label,
  value,
  onChange,
  unit = 'USDC',
  max,
  onMax,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  max?: string;
  onMax?: () => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="spread" style={{ marginBottom: 8 }}>
        <label className="field-label" htmlFor={id} style={{ margin: 0 }}>
          {label}
        </label>
        {onMax && (
          <button type="button" className="max-btn" onClick={onMax} disabled={disabled}>
            Max{max ? ` ${max}` : ''}
          </button>
        )}
      </div>
      <div className="amount-wrap">
        <input
          id={id}
          className="input input-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const next = cleanAmountInput(e.target.value);
            if (next !== null) onChange(next);
          }}
        />
        <span className="amount-unit">{unit}</span>
      </div>
    </div>
  );
}

/** Parses an amount field and says what's wrong only once there's something typed. */
export function amountState(input: string): { parsed: AmountParse; problem: string | null } {
  const parsed = parseAmount(input);
  return {
    parsed,
    problem: parsed.ok || parsed.reason === 'empty' ? null : AMOUNT_PROBLEMS[parsed.reason],
  };
}

export function StatusChip({ status }: { status: string }) {
  return (
    <span className="status" data-s={status}>
      <span
        className={
          status === 'active' || status === 'settled' || status === 'confirmed'
            ? 'dot'
            : 'dot dot-moss'
        }
      />
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function Qr({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { ecc: 'M', border: 0 });
  let d = '';
  data.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) d += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return (
    <div className="qr">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={label}
        shapeRendering="crispEdges"
      >
        <path d={d} fill="#0A0A0B" />
      </svg>
    </div>
  );
}

export function Row({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="policy-row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
