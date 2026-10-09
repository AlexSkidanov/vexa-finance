import type { Metadata, Viewport } from 'next';
import { Afacad, Chivo_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { DemoBar } from '@/components/app-shell';
import { SessionProvider } from '@/components/session';
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

export const metadata: Metadata = {
  title: { default: 'Vexa', template: '%s · Vexa' },
  description: 'Your private Vexa account: encrypted balances, agents and view keys.',
  applicationName: 'Vexa',
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: { url: '/apple-touch-icon.png', sizes: '180x180' },
  },
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
        <SessionProvider>
          <DemoBar />
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
