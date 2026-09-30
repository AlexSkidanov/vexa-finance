'use client';

import { useEffect, useRef } from 'react';
import { PETALS } from './mark';

const DIRS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** The chain-tone mark; it turns, shrinks and opens its petals as the page scrolls. */
export function HeroMark() {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (!svg || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const petals = Array.from(svg.querySelectorAll<SVGPathElement>('path'));
    let frame = 0;
    const apply = () => {
      frame = 0;
      const p = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * 0.9)));
      svg.style.transform = `rotate(${p * 90}deg) scale(${1 - p * 0.25})`;
      svg.style.opacity = String(1 - p * 0.6);
      petals.forEach((pt, i) => {
        const [dx, dy] = DIRS[i]!;
        const sign = (i + 1) % 2 ? -1 : 1;
        pt.style.transform = `translate(${dx * p * 16}px, ${dy * p * 16}px) rotate(${sign * p * 24}deg)`;
      });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <svg ref={ref} className="hero-mark" viewBox="0 0 96 120" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="hA1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#A66BFF" />
          <stop offset="1" stopColor="#6F7DF5" />
        </linearGradient>
        <linearGradient id="hA2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5A8BEA" />
          <stop offset="1" stopColor="#3EC4C2" />
        </linearGradient>
        <linearGradient id="hA3" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2FDCA6" />
          <stop offset="1" stopColor="#7FE07E" />
        </linearGradient>
        <linearGradient id="hA4" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F0C55E" />
          <stop offset="1" stopColor="#E29A3B" />
        </linearGradient>
      </defs>
      {PETALS.map((d, i) => (
        <path key={d} d={d} fill={`url(#hA${i + 1})`} />
      ))}
    </svg>
  );
}
