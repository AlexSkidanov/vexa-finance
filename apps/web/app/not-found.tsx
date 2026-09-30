import type { Metadata } from 'next';
import { TLink } from '@/components/transition';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false },
};

export default function NotFound() {
  return (
    <section className="wrap sub-hero" style={{ minHeight: '60vh' }}>
      <p className="eyebrow">404</p>
      <h1 className="h1">This page is encrypted. Or it doesn&rsquo;t exist.</h1>
      <p className="lede" style={{ marginBottom: 34 }}>
        The link may be old, or the address mistyped.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <TLink href="/" className="btn btn-primary">
          Back to home
        </TLink>
        <TLink href="/faq/" className="btn btn-secondary">
          Read the FAQ
        </TLink>
      </div>
    </section>
  );
}
