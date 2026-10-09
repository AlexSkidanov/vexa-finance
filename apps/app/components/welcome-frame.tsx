import type { ReactNode } from 'react';
import { SITE_URL } from '@/lib/config';
import { LEGAL } from '@/lib/format';
import { Mark } from './mark';

export function WelcomeFrame({ children }: { children: ReactNode }) {
  return (
    <div className="welcome">
      <header className="welcome-top">
        <a href={SITE_URL} className="brand" aria-label="vexa.finance">
          <Mark height={26} />
          <span className="brand-word">vexa</span>
        </a>
        <a href={SITE_URL} className="btn-text">
          vexa.finance
        </a>
      </header>
      {children}
      <footer className="welcome-foot">
        <span>© 2026 Vexa Finance</span>
        <nav className="row" aria-label="Legal" style={{ gap: 16 }}>
          {LEGAL.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
      </footer>
    </div>
  );
}
