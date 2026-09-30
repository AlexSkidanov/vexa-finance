import type { Metadata, Viewport } from 'next';
import { Afacad, Chivo_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { TransitionProvider } from '@/components/transition';
import { SITE_URL } from '@/lib/site';
import './globals.css';

const afacad = Afacad({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-afacad',
  display: 'swap',
});
const chivo = Chivo_Mono({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  variable: '--font-chivo',
  display: 'swap',
});

const title = 'Vexa — The fully private neobank on Solana';
const description =
  'USDC balances encrypted on Solana. Agent limits enforced by NEAR. Stealth transfers through the Zcash shielded pool. Sign in with a passkey; no seed phrase.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: title, template: '%s · Vexa' },
  description,
  applicationName: 'Vexa',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: { url: '/apple-touch-icon.png', sizes: '180x180' },
  },
  openGraph: {
    type: 'website',
    siteName: 'Vexa',
    title,
    description,
    url: '/',
    images: [{ url: '/og.png', width: 1200, height: 400, alt: 'Vexa' }],
  },
  twitter: { card: 'summary_large_image', title, description, images: ['/og.png'] },
};

export const viewport: Viewport = {
  themeColor: '#0A0A0B',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${afacad.variable} ${chivo.variable}`}>
      <body>
        <noscript>
          <style>
            {'[data-reveal]{opacity:1!important;transform:none!important;filter:none!important}'}
          </style>
        </noscript>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <TransitionProvider>
          <Header />
          <main id="main">{children}</main>
          <Footer />
        </TransitionProvider>
      </body>
    </html>
  );
}
