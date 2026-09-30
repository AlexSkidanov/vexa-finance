'use client';

import Link from 'next/link';
import { PasskeyExplainer, SignInButton, usePasskeyVerdict } from '@/components/passkey';
import { usePhaseRedirect, useSession } from '@/components/session';
import { Loading } from '@/components/ui';
import { WelcomeFrame } from '@/components/welcome-frame';
import { DEMO_AVAILABLE } from '@/lib/config';

export default function Welcome() {
  const phase = usePhaseRedirect(['signed-out', 'locked']);
  const { signOut, signedOutReason, startDemo, demo, profile } = useSession();
  const verdict = usePasskeyVerdict();

  if (phase !== 'signed-out' && phase !== 'locked') {
    return (
      <WelcomeFrame>
        <div className="flow">
          <Loading />
        </div>
      </WelcomeFrame>
    );
  }

  if (phase === 'locked') {
    return (
      <WelcomeFrame>
        <main id="main" className="flow">
          <p className="eyebrow">Locked</p>
          <h1 className="welcome-h1">Welcome back.</h1>
          <p className="page-lede" style={{ marginBottom: 28 }}>
            Your keys only exist while you’re using Vexa. Unlock with your passkey to decrypt your
            balance{profile?.handle ? ` as ${profile.handle}` : ''}.
          </p>
          <div className="stack">
            <SignInButton label="Unlock with passkey" />
            <button type="button" className="btn btn-secondary" onClick={() => signOut()}>
              Sign out
            </button>
          </div>
        </main>
      </WelcomeFrame>
    );
  }

  return (
    <WelcomeFrame>
      <main id="main" className="welcome-main">
        <div className="min0">
          <p className="eyebrow">The fully private neobank on Solana</p>
          <h1 className="welcome-h1">A bank account nobody can read but you.</h1>
          <p className="page-lede">
            USDC balances encrypted on Solana. Agents with limits enforced by NEAR. Stealth
            transfers through the Zcash shielded pool.
          </p>
          {signedOutReason === 'expired' && (
            <p className="notice warn" style={{ marginTop: 24 }}>
              Your session ended. Sign in again with your passkey.
            </p>
          )}
          <div className="stack" style={{ marginTop: 32, maxWidth: 420 }}>
            <Link
              href="/signup/"
              className="btn btn-primary btn-lg"
              aria-disabled={verdict === 'unsupported'}
              style={verdict === 'unsupported' ? { pointerEvents: 'none' } : undefined}
            >
              Create account
            </Link>
            <SignInButton />
            {DEMO_AVAILABLE && !demo && (
              <button type="button" className="btn btn-secondary" onClick={startDemo}>
                Explore the demo
              </button>
            )}
          </div>
        </div>
        <div className="min0">
          <PasskeyExplainer verdict={verdict} />
        </div>
      </main>
    </WelcomeFrame>
  );
}
