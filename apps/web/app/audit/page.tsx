import { AuditForm } from '@/components/audit-form';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta(
  'Audit portal',
  'Open a view key. Decryption happens in this browser; the key is never sent in full, and closing the tab clears everything.',
  '/audit/',
);

export default function Audit() {
  return (
    <section
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: 'clamp(130px,18vh,190px) var(--gutter) clamp(80px,10vw,140px)',
      }}
    >
      <p data-reveal="1" className="eyebrow">
        Audit portal
      </p>
      <h1
        data-reveal="h1"
        data-delay="60"
        style={{
          font: '500 clamp(38px,5vw,64px)/1 var(--sans)',
          letterSpacing: '-.035em',
          color: 'var(--paper)',
          margin: '0 0 16px',
          textWrap: 'balance',
        }}
      >
        Open a view key
      </h1>
      <p
        data-reveal="1"
        data-delay="120"
        style={{
          font: '400 19px/1.45 var(--sans)',
          color: 'var(--body)',
          margin: '0 0 32px',
          textWrap: 'pretty',
        }}
      >
        Paste the key your client gave you. Decryption happens in this browser; the key is never
        sent in full, and closing the tab clears everything.
      </p>
      <AuditForm />
    </section>
  );
}
