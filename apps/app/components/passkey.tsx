'use client';

import { useEffect, useState } from 'react';
import {
  detectPasskeySupport,
  passkeyVerdict,
  SUPPORTED_PASSKEYS,
  type PasskeyVerdict,
} from '@/lib/passkey-support';
import { useSession } from './session';
import { ProblemNote, useAction } from './ui';

export function usePasskeyVerdict(): PasskeyVerdict | null {
  const [v, setV] = useState<PasskeyVerdict | null>(null);
  useEffect(() => {
    void detectPasskeySupport().then((c) => setV(passkeyVerdict(c)));
  }, []);
  return v;
}

export function SupportedList() {
  return (
    <ul className="help" style={{ paddingLeft: 20, margin: '8px 0 0' }}>
      {SUPPORTED_PASSKEYS.map((s) => (
        <li key={s} style={{ marginBottom: 4 }}>
          {s}
        </li>
      ))}
    </ul>
  );
}

/** What a passkey does here, and whether this browser looks able to. */
export function PasskeyExplainer({ verdict }: { verdict: PasskeyVerdict | null }) {
  if (verdict === 'unsupported') {
    return (
      <div className="notice warn" role="alert">
        <strong>This browser can’t hold a Vexa account.</strong> Vexa needs a passkey that supports
        the PRF extension, which is how your keys are made on your device. Try one of these:
        <SupportedList />
      </div>
    );
  }
  return (
    <div className="notice">
      <strong>No seed phrase, no password.</strong> Your passkey signs you in, and a secret only it
      can compute (WebAuthn PRF) becomes your wallet and encryption keys, on this device. Vexa never
      sees them. Works with:
      <SupportedList />
    </div>
  );
}

export function SignInButton({ label = 'Sign in with passkey' }: { label?: string }) {
  const { client, unlocked } = useSession();
  const { busy, error, run } = useAction();
  const noPrf = error?.message.includes('PRF');
  return (
    <div className="stack-sm">
      <button
        type="button"
        className="btn btn-primary btn-lg"
        disabled={!client || busy}
        aria-busy={busy}
        onClick={() =>
          void run(async () => {
            const u = await client!.unlock();
            unlocked(u);
          })
        }
      >
        {busy ? 'Waiting for your passkey…' : label}
      </button>
      <ProblemNote problem={error} />
      {noPrf && <SupportedList />}
    </div>
  );
}
