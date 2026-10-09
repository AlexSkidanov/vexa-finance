'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { NAV, SIGNIN_URL, SIGNUP_URL } from '@/lib/site';
import { Mark } from './mark';
import { setScrollLocked, TLink, usePageTransition } from './transition';

const same = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

export function Header() {
  const pathname = usePathname();
  const { menuOpen, setMenuOpen } = usePageTransition();

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 880px)');
    const onChange = (e: MediaQueryListEvent) => {
      if (!e.matches) setMenuOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [setMenuOpen]);

  useEffect(() => {
    setScrollLocked(menuOpen);
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      setScrollLocked(false);
    };
  }, [menuOpen, setMenuOpen]);

  return (
    <>
      <header className="site-header">
        <TLink href="/" className="brand" aria-label="Vexa home">
          <Mark height={26} />
          <span className="brand-word">vexa</span>
        </TLink>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <TLink
              key={n.href}
              href={n.href}
              aria-current={same(pathname, n.href) ? 'page' : undefined}
            >
              {n.label}
            </TLink>
          ))}
        </nav>
        <div className="head-ctas">
          <a href={SIGNIN_URL} className="head-signin">
            Sign in
          </a>
          <a href={SIGNUP_URL} className="head-open">
            Open an account
          </a>
        </div>
        <button
          type="button"
          className="menu-btn"
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? 'Close' : 'Menu'}
        </button>
      </header>
      {menuOpen && (
        <div id="mobile-menu" className="menu-panel" data-lenis-prevent>
          <nav aria-label="Main">
            {NAV.map((n) => (
              <TLink
                key={n.href}
                href={n.href}
                aria-current={same(pathname, n.href) ? 'page' : undefined}
              >
                {n.label}
              </TLink>
            ))}
          </nav>
          <div className="menu-ctas">
            <a href={SIGNUP_URL} className="open">
              Open an account
            </a>
            <a href={SIGNIN_URL} className="signin">
              Sign in
            </a>
          </div>
        </div>
      )}
    </>
  );
}
