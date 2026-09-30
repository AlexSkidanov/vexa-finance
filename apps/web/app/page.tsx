import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Decrypt } from '@/components/decrypt';
import { HeroMark } from '@/components/hero-mark';
import { LiveReserve } from '@/components/live-reserve';
import { TLink } from '@/components/transition';
import { Code, minCol } from '@/components/ui';
import { SIGNUP_URL } from '@/lib/site';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

const PILLARS = [
  {
    n: '01',
    title: 'Private balances',
    body: 'Your USDC lives as an encrypted balance on Solana. The chain confirms every transfer; only your devices can read the amounts.',
  },
  {
    n: '02',
    title: 'Agents with limits',
    body: 'Give an AI agent its own USDC with a maximum per payment, a daily limit and allowed recipients. NEAR signs only what fits the policy.',
  },
  {
    n: '03',
    title: 'Stealth transfers',
    body: 'Route through the Zcash shielded pool via NEAR Intents so there is no on-chain link between you and the recipient. 10 to 30 minutes, from 5 USDC.',
  },
];

const AGENT_CODE = `import { VexaAgent } from "@vexa/sdk";

const bot = new VexaAgent({ apiKey, credential });

// 402 Payment Required → quote → policy check on NEAR → paid → retried
const res = await bot.fetch("https://api.example.com/v1/report");
const data = await res.json(); // paid 0.25 USDC`;

const EXPLORER: [string, string, string?][] = [
  ['program', 'Vexa Vault'],
  ['instruction', 'confidential_transfer'],
  ['from', '7f3aQ…c91e'],
  ['to', '2b9eK…a4d0'],
  ['amount', '0x9f3e71c0…e2ab4d', 'var(--ash)'],
  ['memo', '0x44a1…0b7c', 'var(--ash)'],
  ['status', 'finalized', 'var(--signal)'],
];

const FEES = [
  { label: 'Deposits and withdrawals', value: '0.10%', note: 'Capped at 5 USDC.' },
  {
    label: 'Transfers between Vexa users',
    value: 'Free',
    note: 'Instant. Amount hidden.',
    signal: true,
  },
  { label: 'Network fees', value: '0', note: 'Vexa pays them. You hold only USDC.' },
];

export default function Home() {
  return (
    <>
      <section className="hero">
        <div className="min0">
          <p data-reveal="1" className="eyebrow" style={{ marginBottom: 22 }}>
            The fully private neobank on Solana
          </p>
          <h1 data-reveal="h1" data-delay="80" className="hero-h1">
            A bank account nobody can read but you.
          </h1>
          <p
            data-reveal="1"
            data-delay="180"
            className="lede"
            style={{ margin: '0 0 34px', maxWidth: 520 }}
          >
            USDC balances encrypted on Solana. Agent limits enforced by NEAR. Stealth transfers
            through the Zcash shielded pool. Sign in with a passkey; no seed phrase.
          </p>
          <div
            data-reveal="1"
            data-delay="260"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}
          >
            <a href={SIGNUP_URL} className="btn btn-primary btn-lg btn-hero">
              Open an account
            </a>
            <TLink href="/how-it-works/" className="btn btn-secondary btn-lg">
              Read how it works
            </TLink>
          </div>
        </div>
        <div
          className="min0"
          style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}
        >
          <HeroMark />
        </div>
      </section>

      {/* What the chain sees vs what you see */}
      <section className="wrap sec">
        <p data-reveal="1" className="eyebrow">
          Encrypted on Solana
        </p>
        <h2 data-reveal="1" data-delay="60" className="h2">
          The explorer shows a transfer happened. Only your device shows the amount.
        </h2>
        <div className="hgrid" style={{ ...minCol(320) }}>
          <div data-reveal="1" data-delay="100" className="hcell">
            <div className="num-label" style={{ marginBottom: 22 }}>
              Solana explorer
            </div>
            <dl className="kv" style={{ margin: 0 }}>
              {EXPLORER.map(([k, v, color]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt className="k">{k}</dt>
                  <dd className="v" style={{ margin: 0, color }}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div
            data-reveal="1"
            data-delay="180"
            className="hcell"
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: 24,
            }}
          >
            <div className="num-label" style={{ marginBottom: 0 }}>
              Your Vexa app
            </div>
            <div>
              <Decrypt
                text="$12.50"
                className="big"
                style={{
                  fontSize: 'clamp(44px,6vw,84px)',
                  whiteSpace: 'pre',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              />
              <div
                style={{
                  font: '400 clamp(18px,1.5vw,22px)/1.4 var(--sans)',
                  color: 'var(--body)',
                  marginTop: 10,
                }}
              >
                Sent to{' '}
                <span style={{ font: '400 .95em var(--mono)', color: 'var(--paper)' }}>
                  @bob.vexa
                </span>{' '}
                · Lunch
              </div>
            </div>
            <div className="chip chip-signal" style={{ alignSelf: 'flex-start' }}>
              <span className="dot" />
              Encrypted on your device
            </div>
          </div>
        </div>
        <p data-reveal="1" className="caption">
          Standard transfers hide the amount, not the fact that two accounts transacted. Stealth
          transfers hide the link as well.
        </p>
      </section>

      {/* Pillars */}
      <section className="wrap sec">
        <div className="grid gap-lg" style={{ ...minCol(300) }}>
          {PILLARS.map((p, i) => (
            <div key={p.n} data-reveal="1" data-delay={String(i * 100)} className="ncard">
              <div className="ncard-n">{p.n}</div>
              <h3
                className="h3"
                style={{ fontSize: 'clamp(28px,2.6vw,38px)', textWrap: 'balance' }}
              >
                {p.title}
              </h3>
              <p
                style={{
                  font: '400 clamp(17px,1.3vw,19px)/1.45 var(--sans)',
                  color: 'var(--body)',
                  margin: 0,
                  textWrap: 'pretty',
                }}
              >
                {p.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Passkey */}
      <section className="wrap sec">
        <div
          className="grid gap-lg"
          style={{
            ...minCol(300),
            border: '1px solid var(--hair)',
            padding: 'clamp(28px,5vw,64px)',
            alignItems: 'center',
          }}
        >
          <div data-reveal="1" className="min0">
            <h2 className="h2-md">Sign in with a passkey. No seed phrase.</h2>
            <p className="body">
              Your passkey is your wallet. It derives your Solana keys, encryption keys and agent
              keys on your device and syncs through iCloud Keychain or Google Password Manager. Vexa
              never holds them, so add a second passkey.
            </p>
          </div>
          <div
            data-reveal="1"
            data-delay="120"
            style={{ display: 'flex', justifyContent: 'space-around', gap: 20, flexWrap: 'wrap' }}
          >
            <Device label="Phone">
              <rect x="17" y="6" width="22" height="44" rx="4" />
              <line x1="25" y1="44" x2="31" y2="44" />
            </Device>
            <Device label="Laptop">
              <rect x="9" y="12" width="38" height="26" rx="3" />
              <line x1="4" y1="44" x2="52" y2="44" />
            </Device>
            <Device label="Passkey" stroke="#3DE6A5">
              <circle cx="20" cy="28" r="10" />
              <line x1="30" y1="28" x2="50" y2="28" />
              <line x1="44" y1="28" x2="44" y2="36" />
              <line x1="50" y1="28" x2="50" y2="34" />
            </Device>
          </div>
        </div>
      </section>

      {/* Fees */}
      <section className="wrap sec-sm">
        <div data-reveal="1" className="hgrid" style={{ ...minCol(220) }}>
          {FEES.map((f) => (
            <div key={f.label} className="hcell">
              <div className="num-label">{f.label}</div>
              <div
                className={f.signal ? 'big signal' : 'big'}
                style={{ fontSize: 'clamp(40px,4vw,56px)' }}
              >
                {f.value}
              </div>
              <div className="note">{f.note}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16 }}>
          <TLink href="/pricing/" className="tlink hit">
            See pricing and the fee calculator
          </TLink>
        </div>
      </section>

      {/* Developers strip */}
      <section className="wrap sec grid gap-lg" style={{ ...minCol(320), alignItems: 'center' }}>
        <div data-reveal="1" className="min0">
          <p className="eyebrow">Developers</p>
          <h2 className="h2-md">Your agent pays for APIs by itself, within the limits you set.</h2>
          <p className="body" style={{ marginBottom: 28 }}>
            When an API answers 402 Payment Required, the agent pays in USDC and retries. A NEAR
            contract signs the payment only if it fits the policy.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <TLink href="/developers/" className="btn btn-secondary btn-sm">
              Read the docs
            </TLink>
            <TLink href="/agents/" className="btn-text">
              About agents
            </TLink>
          </div>
        </div>
        <Code
          code={AGENT_CODE}
          reveal={{ delay: 120 }}
          style={{
            padding: 'clamp(18px,2.6vw,30px)',
            fontSize: 'clamp(12.5px,1.05vw,14.5px)',
          }}
        />
      </section>

      {/* Transparency strip */}
      <section className="wrap sec-sm">
        <LiveReserve variant="home" />
      </section>
    </>
  );
}

function Device({
  label,
  stroke = '#F2F2F2',
  children,
}: {
  label: string;
  stroke?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'grid',
        justifyItems: 'center',
        gap: 12,
        font: '400 14px/1 var(--mono)',
        color: 'var(--ash)',
      }}
    >
      <svg
        width="56"
        height="56"
        viewBox="0 0 56 56"
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        aria-hidden="true"
        focusable="false"
      >
        {children}
      </svg>
      {label}
    </div>
  );
}
