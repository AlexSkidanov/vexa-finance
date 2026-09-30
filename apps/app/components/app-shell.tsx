'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Icon } from './icons';
import { Mark } from './mark';
import { usePhaseRedirect, useSession } from './session';
import { Loading } from './ui';

const NAV = [
  { href: '/home/', label: 'Home', icon: Icon.home },
  { href: '/send/', label: 'Send', icon: Icon.send },
  { href: '/add/', label: 'Add money', icon: Icon.add },
  { href: '/withdraw/', label: 'Withdraw', icon: Icon.withdraw },
  { href: '/activity/', label: 'Activity', icon: Icon.activity },
  { href: '/agents/', label: 'Agents', icon: Icon.agents },
  { href: '/privacy/', label: 'Privacy', icon: Icon.privacy },
  { href: '/vexa/', label: '$VEXA', icon: Icon.token },
  { href: '/settings/', label: 'Settings', icon: Icon.settings },
];

const TABS = [
  { href: '/home/', label: 'Home', icon: Icon.home },
  { href: '/send/', label: 'Send', icon: Icon.send },
  { href: '/activity/', label: 'Activity', icon: Icon.activity },
  { href: '/agents/', label: 'Agents', icon: Icon.agents },
  { href: '/settings/', label: 'More', icon: Icon.more, also: ['/privacy/', '/vexa/'] },
];

const current = (pathname: string, href: string, also: string[] = []) =>
  [href, ...also].some((h) => pathname.startsWith(h.replace(/\/$/, '')));

export function DemoBar() {
  const { demo, exitDemo } = useSession();
  if (!demo) return null;
  return (
    <div className="demo-bar" role="note">
      <span>Demo mode · sample data · nothing here is real</span>
      <button type="button" onClick={exitDemo}>
        Leave demo
      </button>
    </div>
  );
}

/** Frame for every signed-in screen: sidebar on desktop, top bar and tabs on phones. */
export function AppShell({ children }: { children: ReactNode }) {
  const phase = usePhaseRedirect(['ready']);
  const { profile, lock, demo } = useSession();
  const pathname = usePathname();

  if (phase !== 'ready') {
    return (
      <div className="flow">
        <Loading label="Opening your account…" />
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="side" aria-label="Main">
        <Link href="/home/" className="brand" aria-label="Vexa home">
          <Mark height={24} />
          <span className="brand-word">vexa</span>
          {demo && <span className="demo-chip">Demo</span>}
        </Link>
        <nav className="side-nav">
          {NAV.map(({ href, label, icon: Ic }) => (
            <Link
              key={href}
              href={href}
              aria-current={current(pathname, href) ? 'page' : undefined}
            >
              <Ic />
              {label}
            </Link>
          ))}
        </nav>
        <div className="side-foot">
          <div className="who" title={profile?.handle ?? undefined}>
            {profile?.handle}
          </div>
          <button type="button" className="icon-btn" onClick={lock}>
            <Icon.lock />
            Lock
          </button>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <Link href="/home/" className="brand" aria-label="Vexa home">
            <Mark height={22} />
            <span className="brand-word" style={{ fontSize: 22 }}>
              vexa
            </span>
            {demo && <span className="demo-chip">Demo</span>}
          </Link>
          <button type="button" className="icon-btn" onClick={lock} aria-label="Lock">
            <Icon.lock />
          </button>
        </header>
        <main id="main" className="page">
          {children}
        </main>
        <nav className="tabbar" aria-label="Main">
          {TABS.map(({ href, label, icon: Ic, also }) => (
            <Link
              key={href}
              href={href}
              aria-current={current(pathname, href, also) ? 'page' : undefined}
            >
              <Ic />
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
