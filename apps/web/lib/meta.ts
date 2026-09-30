import type { Metadata } from 'next';

const images = [{ url: '/og.png', width: 1200, height: 400, alt: 'Vexa' }];

/** Per-page metadata with the shared Open Graph image and a canonical URL. */
export function pageMeta(title: string, description: string, path: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: 'website', siteName: 'Vexa', title, description, url: path, images },
    twitter: { card: 'summary_large_image', title, description, images: ['/og.png'] },
  };
}
