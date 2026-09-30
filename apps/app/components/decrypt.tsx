'use client';

import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';

const GLYPHS = '▓▒░#%&@$0123456789abcdef';
const keep = (c: string) => c === ' ' || c === ',' || c === '.';
const veil = (text: string) => [...text].map((c) => (keep(c) ? c : '▒')).join('');

/**
 * A number that shows as ▒ and resolves left to right once it's decrypted.
 * Screen readers get the final value straight away.
 */
export function Decrypt({
  text,
  className,
  style,
  fallback = '—',
}: {
  /** null while loading or unavailable. */
  text: string | null;
  className?: string;
  style?: CSSProperties;
  fallback?: string;
}) {
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (text === null) return;
    if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(text);
      return;
    }
    const chars = [...text];
    const dur = Math.max(900, chars.length * 70);
    let t0 = 0;
    let timer = 0;
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / dur);
      let f = '';
      chars.forEach((c, i) => {
        f +=
          keep(c) || i / chars.length < p ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      });
      setShown(f);
      if (p < 1) timer = window.setTimeout(tick, 42);
    };
    timer = window.setTimeout(() => {
      t0 = performance.now();
      tick();
    }, 120);
    return () => clearTimeout(timer);
  }, [text]);

  const visible = text === null ? fallback : (shown ?? veil(text));
  return (
    <div
      className={className}
      style={style}
      role="img"
      aria-label={text ?? (fallback === '—' ? 'Not available' : 'Loading')}
    >
      {visible}
    </div>
  );
}
