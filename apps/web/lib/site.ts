/** Site-wide constants: routes, external links and on-chain addresses. */

export const SITE_URL = 'https://vexa.finance';
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'https://api.vexa.finance').replace(
  /\/+$/,
  '',
);

export const APP_URL = 'https://app.vexa.finance';
export const SIGNUP_URL = `${APP_URL}/signup`;
export const SIGNIN_URL = `${APP_URL}/signin`;

export const GITHUB_URL = 'https://github.com/AlexSkidanov/vexa-finance';
const blob = `${GITHUB_URL}/blob/main`;
export const DOCS = {
  quickstart: `${GITHUB_URL}#quickstart`,
  api: `${blob}/docs/API.md`,
  agents: `${blob}/docs/API.md#agents`,
  x402: `${blob}/docs/API.md#x402`,
  webhooks: `${blob}/docs/API.md#webhooks`,
  changelog: `${blob}/CHANGELOG.md`,
  architecture: `${blob}/docs/ARCHITECTURE.md`,
  security: `${blob}/SECURITY.md`,
  quantum: `${blob}/docs/QUANTUM.md`,
} as const;

/** Near One's post-quantum write-ups and the release that shipped ML-DSA. */
export const NEAR_PQ = {
  intro: 'https://www.near.org/blog/making-near-protocol-post-quantum-safe',
  roadmap: 'https://www.near.org/blog/near-quantum-safe-roadmap',
  release: 'https://github.com/near/nearcore/releases/tag/2.13.0',
} as const;

/** The on-chain proof that vexa-policy.near is controlled only by ML-DSA-65. */
export const PQ_ROTATION = {
  date: '9 October 2026',
  addKeyTx: 'https://nearblocks.io/txns/2yrhU1vG2ADTYL8YYaCFwzKgUrJwtB4LsviUgNqqkU6e',
  removeEd25519Tx: 'https://nearblocks.io/txns/5pRfnDPVC4bvj1eEdsCyfo9PmbrxgQUmxhPGuUzWKxk9',
  keys: 'https://nearblocks.io/address/vexa-policy.near/keys',
} as const;
export const STATUS_URL = `${API_URL}/health`;
export const SECURITY_EMAIL = 'security@vexa.finance';
export const CONTACT_EMAIL = 'hello@vexa.finance';

export const solscanAccount = (addr: string) => `https://solscan.io/account/${addr}`;
export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;

export const CONTRACTS = {
  vault: '3g2JPX4roASUJVacf68sBSpARk5m9B3hu9xeaE6mTjPR',
  cusdcMint: '4STXpFN2mQSt12XG4os7ftLXHbBq5PVWYCAahToRt6QQ',
  reserve: '8eeishQYvtHwwM8QRN9629zzU9hBn18dGFW5T75ytqz6',
  feeSchedule: '4PAtQdQRVfozc2F8x4eJF1oHhAQ6EMfX5EqBgPGnj29u',
  treasury: '713NQALYzFN2zVSJ1ERqhSFiQTMqVnFyCVybYdn3r9Gj',
  policy: 'vexa-policy.near',
} as const;

export const CONTRACT_LIST: { name: string; chain: string; addr: string; href: string }[] = [
  {
    name: 'Vault program',
    chain: 'Solana',
    addr: CONTRACTS.vault,
    href: solscanAccount(CONTRACTS.vault),
  },
  {
    name: 'cUSDC mint',
    chain: 'Solana',
    addr: CONTRACTS.cusdcMint,
    href: solscanAccount(CONTRACTS.cusdcMint),
  },
  {
    name: 'Reserve',
    chain: 'Solana',
    addr: CONTRACTS.reserve,
    href: solscanAccount(CONTRACTS.reserve),
  },
  {
    name: 'Fee schedule',
    chain: 'Solana',
    addr: CONTRACTS.feeSchedule,
    href: solscanAccount(CONTRACTS.feeSchedule),
  },
  {
    name: 'Treasury',
    chain: 'Solana',
    addr: CONTRACTS.treasury,
    href: solscanAccount(CONTRACTS.treasury),
  },
  {
    name: 'Agent policy contract',
    chain: 'NEAR',
    addr: CONTRACTS.policy,
    href: `https://nearblocks.io/address/${CONTRACTS.policy}`,
  },
];

/** $VEXA's contract address: a Token-2022 mint launched on pump.fun. */
export const VEXA_MINT = '71ur38S2zxj1DaA2Untd8VYmAEkvyeXWkw3gycPDpump';
export const VEXA_LINKS = {
  solscan: `https://solscan.io/token/${VEXA_MINT}`,
  pumpfun: `https://pump.fun/coin/${VEXA_MINT}`,
} as const;

export const VAULT_VERSION = 'v0.6.0';
export const VAULT_SHA256 = 'fb44d4942763a688ba5d8362e418bf1fc25c15973923ba7713028d9e11527692';
export const VAULT_BYTES = 53_688;

export const NAV: { href: string; label: string }[] = [
  { href: '/how-it-works/', label: 'How it works' },
  { href: '/agents/', label: 'Agents' },
  { href: '/stealth/', label: 'Stealth' },
  { href: '/vexa/', label: '$VEXA' },
  { href: '/pricing/', label: 'Pricing' },
  { href: '/security/', label: 'Security' },
  { href: '/developers/', label: 'Developers' },
];

export const FOOTER: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: 'Product',
    links: [
      { href: '/how-it-works/', label: 'How it works' },
      { href: '/agents/', label: 'Agents' },
      { href: '/stealth/', label: 'Stealth transfers' },
      { href: '/vexa/', label: '$VEXA' },
      { href: '/pricing/', label: 'Pricing' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { href: '/developers/', label: 'Developers' },
      { href: DOCS.quickstart, label: 'Docs' },
      { href: '/audit/', label: 'Audit portal' },
      { href: STATUS_URL, label: 'Status' },
      { href: GITHUB_URL, label: 'GitHub' },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: '/security/', label: 'Security' },
      { href: '/quantum/', label: 'Quantum readiness' },
      { href: '/faq/', label: 'FAQ' },
      { href: '/about/', label: 'About' },
      { href: `mailto:${CONTACT_EMAIL}`, label: 'Contact' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { href: '/terms/', label: 'Terms' },
      { href: '/privacy/', label: 'Privacy policy' },
      { href: '/risk/', label: 'Risk disclosures' },
    ],
  },
];
