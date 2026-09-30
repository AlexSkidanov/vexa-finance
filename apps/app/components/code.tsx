import type { CSSProperties, ReactNode } from 'react';

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
