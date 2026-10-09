import type { CSSProperties, ReactNode } from 'react';

/** Sets the minimum column width for .grid and .hgrid. */
export const minCol = (px: number) => ({ '--min': `${px}px` }) as CSSProperties;

/** Eyebrow, H1 and optional lede at the top of every sub-page. */
export function SubHero({
  eyebrow,
  title,
  lede,
  flush,
  children,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  /** No space under the H1 (nothing follows it). */
  flush?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="wrap sub-hero">
      <p data-reveal="1" className="eyebrow">
        {eyebrow}
      </p>
      <h1
        data-reveal="h1"
        data-delay="60"
        className="h1"
        style={flush ? { marginBottom: 0 } : undefined}
      >
        {title}
      </h1>
      {lede && (
        <p data-reveal="1" data-delay="140" className="lede">
          {lede}
        </p>
      )}
      {children}
    </section>
  );
}

const TOKEN_RE =
  /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")|\b(import|from|const|new|await|export|async|return)\b/g;

/** Minimal JS highlighting: keywords and comments in Moss, strings in Signal. */
export function Code({
  code,
  style,
  className = 'code',
  reveal,
}: {
  code: string;
  style?: CSSProperties;
  className?: string;
  reveal?: { delay?: number };
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of code.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(code.slice(last, at));
    parts.push(
      <span key={i++} className={m[2] ? 's' : 'k'}>
        {m[0]}
      </span>,
    );
    last = at + m[0].length;
  }
  if (last < code.length) parts.push(code.slice(last));
  return (
    <pre
      className={className}
      style={style}
      tabIndex={0}
      {...(reveal
        ? { 'data-reveal': '1', ...(reveal.delay ? { 'data-delay': String(reveal.delay) } : {}) }
        : {})}
    >
      {parts}
    </pre>
  );
}

export const TIERS = [
  { tier: '0', weight: '0', disc: '0%', agents: '3', limit: '$500' },
  { tier: '1', weight: '1,000', disc: '10%', agents: '5', limit: '$2,500' },
  { tier: '2', weight: '10,000', disc: '25%', agents: '10', limit: '$10,000' },
  { tier: '3', weight: '100,000', disc: '50%', agents: '25', limit: '$25,000' },
  { tier: '4', weight: '1,000,000', disc: '75%', agents: '50', limit: '$50,000' },
];

export function DataTable({
  label,
  head,
  rows,
  template,
  minWidth,
  cell,
  headStyle,
}: {
  label: string;
  head: string[];
  rows: ReactNode[][];
  template: string;
  minWidth: number;
  /** Class and style for a body cell, by column. */
  cell?: (col: number) => { className?: string; style?: CSSProperties };
  headStyle?: (col: number) => CSSProperties | undefined;
}) {
  return (
    <div className="tscroll" tabIndex={0} role="region" aria-label={label}>
      <div
        className="tbl"
        role="table"
        aria-label={label}
        style={{ minWidth, gridTemplateColumns: template }}
      >
        <div role="row" style={{ display: 'contents' }}>
          {head.map((h, c) => (
            <div key={h} className="th" role="columnheader" style={headStyle?.(c)}>
              {h}
            </div>
          ))}
        </div>
        {rows.map((r, i) => (
          <div key={i} role="row" style={{ display: 'contents' }}>
            {r.map((v, c) => {
              const x = cell?.(c) ?? {};
              return (
                <div key={c} role="cell" className={x.className ?? 'td'} style={x.style}>
                  {v}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TierTable({ signalDiscount }: { signalDiscount?: boolean }) {
  return (
    <div data-reveal="1" data-delay="80">
      <DataTable
        label="Tiers"
        head={['Tier', 'Weight ($VEXA)', 'Fee discount', 'Agents', 'Agent limit / day']}
        rows={TIERS.map((t) => [t.tier, t.weight, t.disc, t.agents, t.limit])}
        template=".6fr 1.2fr 1fr .8fr 1.2fr"
        minWidth={520}
        cell={(c) => ({
          className: c === 0 ? 'td first' : c === 2 && signalDiscount ? 'td signal' : 'td',
        })}
      />
    </div>
  );
}

export function Stat({
  label,
  value,
  note,
  size,
  valueClass,
  delay,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  size: string;
  valueClass?: string;
  delay?: number;
}) {
  return (
    <div className="hcell" data-reveal="1" {...(delay ? { 'data-delay': String(delay) } : {})}>
      <div className="num-label">{label}</div>
      <div className={`big ${valueClass ?? ''}`} style={{ fontSize: size }}>
        {value}
      </div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}
