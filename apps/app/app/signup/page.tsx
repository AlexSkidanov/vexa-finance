'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { PasskeyExplainer, SupportedList, usePasskeyVerdict } from '@/components/passkey';
import { usePhaseRedirect, useSession } from '@/components/session';
import {
  Loading,
  newIdempotencyKey,
  ProblemNote,
  Steps,
  useAction,
  type StepState,
} from '@/components/ui';
import { WelcomeFrame } from '@/components/welcome-frame';
import { formatHandle, handleProblem, normalizeHandle } from '@/lib/handles';

type Step = 'email' | 'code' | 'passkey' | 'unlock' | 'handle' | 'account';
const ORDER: Step[] = ['email', 'code', 'passkey', 'handle', 'account'];

export default function SignUp() {
  const phase = usePhaseRedirect(['signed-out', 'needs-passkey', 'locked', 'onboarding']);
  const { profile } = useSession();
  const [email, setEmail] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [justRegistered, setJustRegistered] = useState(false);

  let step: Step | null = null;
  if (phase === 'signed-out') step = codeSent ? 'code' : 'email';
  else if (phase === 'needs-passkey') step = 'passkey';
  else if (phase === 'locked') step = 'unlock';
  else if (phase === 'onboarding') step = profile?.handle ? 'account' : 'handle';

  const at = ORDER.indexOf(step === 'unlock' ? 'passkey' : (step ?? 'email'));

  return (
    <WelcomeFrame>
      <main id="main" className="flow">
        {step && (
          <div className="progress" aria-hidden="true">
            {ORDER.map((s, i) => (
              <span key={s} data-on={i <= at} />
            ))}
          </div>
        )}
        {!step && <Loading />}
        {step === 'email' && (
          <EmailStep email={email} setEmail={setEmail} onSent={() => setCodeSent(true)} />
        )}
        {step === 'code' && <CodeStep email={email} onBack={() => setCodeSent(false)} />}
        {step === 'passkey' && <PasskeyStep onRegistered={() => setJustRegistered(true)} />}
        {step === 'unlock' && <UnlockStep sameAccount={justRegistered} />}
        {step === 'handle' && <HandleStep />}
        {step === 'account' && <AccountStep />}
      </main>
    </WelcomeFrame>
  );
}

function EmailStep({
  email,
  setEmail,
  onSent,
}: {
  email: string;
  setEmail: (v: string) => void;
  onSent: () => void;
}) {
  const { client } = useSession();
  const { busy, error, run } = useAction();
  const verdict = usePasskeyVerdict();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void run(async () => {
          await client!.sendOtp(email.trim());
          onSent();
        });
      }}
    >
      <div>
        <p className="eyebrow">Create account · 1 of 5</p>
        <h1 className="page-title">Start with your email.</h1>
        <p className="page-lede">
          We’ll send a one-time code. Your email is for account recovery notices and receipts; it’s
          never linked on-chain.
        </p>
      </div>
      <div>
        <label className="field-label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <ProblemNote problem={error} />
      <button
        className="btn btn-primary btn-lg"
        disabled={!valid || busy || !client || verdict === 'unsupported'}
        aria-busy={busy}
      >
        {busy ? 'Sending…' : 'Send code'}
      </button>
      <PasskeyExplainer verdict={verdict} />
      <p className="help">
        Already have an account? <Link href="/signin/">Sign in with your passkey</Link>.
      </p>
    </form>
  );
}

function CodeStep({ email, onBack }: { email: string; onBack: () => void }) {
  const { client, sync } = useSession();
  const { busy, error, run } = useAction();
  const [code, setCode] = useState('');
  const [existing, setExisting] = useState(false);
  const resend = useAction();

  if (existing) {
    return (
      <div className="stack">
        <p className="eyebrow">Create account</p>
        <h1 className="page-title">You already have an account.</h1>
        <p className="page-lede">
          {email} already has Vexa keys. They come from the passkey you set up then, so sign in with
          that passkey. A new one would make different keys and couldn’t open your balance.
        </p>
        <Link href="/signin/" className="btn btn-primary btn-lg">
          Sign in with passkey
        </Link>
      </div>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const profile = await client!.verifyOtp(email.trim(), code);
          if (profile?.solanaPubkey) {
            // Keep the session from binding a second passkey to these keys.
            client!.signOut();
            setExisting(true);
            return;
          }
          sync();
        });
      }}
    >
      <div>
        <p className="eyebrow">Create account · 2 of 5</p>
        <h1 className="page-title">Check your email.</h1>
        <p className="page-lede">Enter the code we sent to {email}.</p>
      </div>
      <div>
        <label className="field-label" htmlFor="code">
          Code
        </label>
        <input
          id="code"
          className="input otp"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={10}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </div>
      <ProblemNote problem={error ?? resend.error} />
      <button
        className="btn btn-primary btn-lg"
        disabled={code.length < 6 || busy}
        aria-busy={busy}
      >
        {busy ? 'Checking…' : 'Continue'}
      </button>
      <div className="row">
        <button type="button" className="btn-text" onClick={onBack}>
          Use a different email
        </button>
        <button
          type="button"
          className="btn-text"
          disabled={resend.busy}
          onClick={() => void resend.run(() => client!.sendOtp(email.trim()))}
        >
          {resend.busy ? 'Sending…' : 'Send a new code'}
        </button>
      </div>
    </form>
  );
}

function PasskeyStep({ onRegistered }: { onRegistered: () => void }) {
  const { client, sync } = useSession();
  const { busy, error, run } = useAction();
  return (
    <div className="stack">
      <div>
        <p className="eyebrow">Create account · 3 of 5</p>
        <h1 className="page-title">Create your passkey.</h1>
        <p className="page-lede">
          It replaces passwords and seed phrases. Save it in a password manager that syncs (iCloud
          Keychain, Google Password Manager, 1Password) so a lost phone doesn’t mean lost money:
          without this passkey, nobody can open your balance, including us.
        </p>
      </div>
      <ProblemNote problem={error} />
      <button
        type="button"
        className="btn btn-primary btn-lg"
        disabled={busy}
        aria-busy={busy}
        onClick={() =>
          void run(async () => {
            await client!.registerPasskey();
            onRegistered();
            sync();
          })
        }
      >
        {busy ? 'Waiting for your passkey…' : 'Create passkey'}
      </button>
      <p className="help">
        Your browser will ask twice: once to create the passkey, then once to use it, which is when
        your keys are made.
      </p>
    </div>
  );
}

function UnlockStep({ sameAccount }: { sameAccount: boolean }) {
  const { client, unlocked } = useSession();
  const { busy, error, run } = useAction();
  return (
    <div className="stack">
      <div>
        <p className="eyebrow">Create account · 3 of 5</p>
        <h1 className="page-title">Now make your keys.</h1>
        <p className="page-lede">
          Use the passkey you just created. It computes a secret that becomes your Solana wallet and
          your encryption keys, here on this device.
        </p>
      </div>
      <ProblemNote problem={error} />
      {error?.message.includes('PRF') && <SupportedList />}
      <button
        type="button"
        className="btn btn-primary btn-lg"
        disabled={busy}
        aria-busy={busy}
        onClick={() =>
          void run(async () => {
            unlocked(await client!.unlock({ sameAccount }));
          })
        }
      >
        {busy ? 'Waiting for your passkey…' : 'Use passkey'}
      </button>
    </div>
  );
}

function HandleStep() {
  const { client, setProfile } = useSession();
  const { busy, error, run } = useAction();
  const [input, setInput] = useState('');
  const [check, setCheck] = useState<{
    handle: string;
    state: 'checking' | 'free' | 'taken' | 'error';
  } | null>(null);
  const keys = useRef(new Map<string, string>());
  const problem = input ? handleProblem(input) : null;
  const handle = normalizeHandle(input);

  useEffect(() => {
    if (!input || problem) {
      setCheck(null);
      return;
    }
    setCheck({ handle, state: 'checking' });
    const t = setTimeout(() => {
      client!.handleAvailable(handle).then(
        (free) =>
          setCheck((c) => (c?.handle === handle ? { handle, state: free ? 'free' : 'taken' } : c)),
        () => setCheck((c) => (c?.handle === handle ? { handle, state: 'error' } : c)),
      );
    }, 400);
    return () => clearTimeout(t);
  }, [input, problem, handle, client]);

  const ready = check?.handle === handle && check.state === 'free';
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        // One key per handle, so a retry of the same claim can't claim twice.
        if (!keys.current.has(handle)) keys.current.set(handle, newIdempotencyKey());
        void run(async () => {
          setProfile(await client!.claimHandle(handle, keys.current.get(handle)!));
        });
      }}
    >
      <div>
        <p className="eyebrow">Create account · 4 of 5</p>
        <h1 className="page-title">Pick your handle.</h1>
        <p className="page-lede">
          People pay you at @name.vexa instead of a long address. It’s public, and permanent for
          now, so choose one you’re happy to share.
        </p>
      </div>
      <div>
        <label className="field-label" htmlFor="handle">
          Handle
        </label>
        <div className="amount-wrap">
          <input
            id="handle"
            className="input"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="yourname"
            value={input}
            maxLength={26}
            onChange={(e) => setInput(e.target.value)}
            style={{ paddingRight: 80 }}
          />
          <span className="amount-unit">.vexa</span>
        </div>
        <div aria-live="polite">
          {problem && <p className="field-error">{problem}</p>}
          {!problem && check?.state === 'checking' && <p className="help">Checking…</p>}
          {!problem && check?.state === 'free' && (
            <p className="field-ok">{formatHandle(handle)} is available.</p>
          )}
          {!problem && check?.state === 'taken' && (
            <p className="field-error">{formatHandle(handle)} is taken.</p>
          )}
          {!problem && check?.state === 'error' && (
            <p className="field-error">Couldn’t check that one. Try again in a moment.</p>
          )}
        </div>
      </div>
      <ProblemNote problem={error} />
      <button className="btn btn-primary btn-lg" disabled={!ready || busy} aria-busy={busy}>
        {busy ? 'Claiming…' : ready ? `Claim ${formatHandle(handle)}` : 'Claim handle'}
      </button>
    </form>
  );
}

function AccountStep() {
  const { client, profile, accountOpened } = useSession();
  const { busy, error, run } = useAction();
  const [state, setState] = useState<StepState>('active');
  const started = useRef(false);

  const open = () =>
    void run(async () => {
      setState('active');
      try {
        await client!.openAccount();
      } catch (e) {
        setState('error');
        throw e;
      }
      setState('done');
      accountOpened();
    });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    open();
  }, []);

  return (
    <div className="stack">
      <div>
        <p className="eyebrow">Create account · 5 of 5</p>
        <h1 className="page-title">Opening your private account.</h1>
        <p className="page-lede">
          A confidential USDC account on Solana, with your encryption key registered. Vexa pays the
          network fees and rent.
        </p>
      </div>
      <Steps
        steps={[
          { label: 'Keys made on this device', state: 'done' },
          { label: `Handle claimed: ${profile?.handle ?? ''}`, state: 'done' },
          {
            label: 'Private account opened on Solana',
            state,
            detail:
              state === 'active'
                ? 'Proving your key and confirming the transaction. Usually under a minute.'
                : undefined,
          },
        ]}
      />
      <ProblemNote problem={error} />
      {state === 'error' && (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={open}>
          Try again
        </button>
      )}
    </div>
  );
}
