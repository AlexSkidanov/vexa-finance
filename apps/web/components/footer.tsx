import { FOOTER } from '@/lib/site';
import { Mark } from './mark';
import { StatusChip } from './status-chip';
import { SmartLink } from './transition';

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="foot-inner">
        <div className="foot-top">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Mark height={22} />
            <span className="brand-word" style={{ fontSize: 22 }}>
              vexa
            </span>
          </div>
          <div className="foot-tag">
            The fully private neobank on Solana, secured by NEAR and ZEC. Preparing for Q-Day in the
            open.
          </div>
        </div>
        {FOOTER.map((c) => (
          <nav key={c.title} className="min0" aria-label={c.title}>
            <div className="foot-title">{c.title}</div>
            <div className="foot-links">
              {c.links.map((l) => (
                <SmartLink key={l.label} href={l.href}>
                  {l.label}
                </SmartLink>
              ))}
            </div>
          </nav>
        ))}
        <div className="foot-bottom">
          <span>© 2026 Vexa Finance</span>
          <StatusChip />
        </div>
      </div>
    </footer>
  );
}
