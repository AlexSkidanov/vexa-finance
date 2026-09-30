import type { ReactNode } from 'react';

/** A plain reading page for legal and about copy. */
export function ProsePage({
  eyebrow,
  title,
  updated,
  children,
}: {
  eyebrow: string;
  title: string;
  updated?: string;
  children: ReactNode;
}) {
  return (
    <>
      <section className="wrap sub-hero">
        <p data-reveal="1" className="eyebrow">
          {eyebrow}
        </p>
        <h1
          data-reveal="h1"
          data-delay="60"
          className="h1"
          style={{ marginBottom: updated ? 18 : 0 }}
        >
          {title}
        </h1>
        {updated && (
          <p
            data-reveal="1"
            data-delay="120"
            className="eyebrow m0"
            style={{ color: 'var(--moss)' }}
          >
            {updated}
          </p>
        )}
      </section>
      <section className="wrap sec-next">
        <div data-reveal="1" className="prose" style={{ borderTop: '1px solid var(--paper)' }}>
          {children}
        </div>
      </section>
    </>
  );
}
