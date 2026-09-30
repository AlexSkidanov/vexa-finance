import { Faq } from '@/components/faq';
import { SubHero } from '@/components/ui';
import { pageMeta } from '@/lib/meta';

export const metadata = pageMeta(
  'FAQ',
  'Questions people ask before opening an account: passkeys, custody, who can see your balance, cUSDC, withdrawals and stealth transfer costs.',
  '/faq/',
);

const FAQS: [string, string][] = [
  [
    'What if I lose my passkey?',
    'If you lose every passkey, nobody can recover the account, including Vexa. Passkeys sync through iCloud Keychain or Google Password Manager, and the app asks you to add a second one on another device.',
  ],
  [
    'Is Vexa custodial?',
    'No. Your keys are derived from your passkey and live on your devices. Vexa can pause deposits and withdrawals but cannot move your funds or read your balance.',
  ],
  [
    'Who can see my balance?',
    'Only devices signed in with your passkey. If you want an accountant to see a period of activity, create a view key for that date range and revoke it when done.',
  ],
  [
    'Why a handle instead of an address?',
    'People send to @name.vexa. Raw Solana addresses appear only for deposits, withdrawals and technical details.',
  ],
  [
    'What is cUSDC?',
    'A confidential token on Solana backed one to one by USDC in the reserve. Your private balance is cUSDC. Withdraw and it becomes USDC again.',
  ],
  [
    'Can I withdraw to an exchange?',
    'Yes, to any address that already has a USDC account. If the address has never held USDC, send it any USDC first or use an exchange deposit address.',
  ],
  [
    'What does a stealth transfer cost?',
    'About $0.60 in bridge fees plus 0.10% on the way out and 0.10% on the way back in. It takes 10 to 30 minutes and needs at least 5 USDC.',
  ],
];

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQS.map(([q, a]) => ({
    '@type': 'Question',
    name: q,
    acceptedAnswer: { '@type': 'Answer', text: a },
  })),
};

export default function FaqPage() {
  return (
    <>
      <SubHero eyebrow="FAQ" title="Questions people ask before opening an account." flush />
      <section className="wrap sec-next">
        <Faq items={FAQS} />
      </section>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </>
  );
}
