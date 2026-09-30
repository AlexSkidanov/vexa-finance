'use client';

import Link from 'next/link';
import { PasskeyExplainer, SignInButton, usePasskeyVerdict } from '@/components/passkey';
import { usePhaseRedirect } from '@/components/session';
import { WelcomeFrame } from '@/components/welcome-frame';

export default function SignIn() {
  usePhaseRedirect(['signed-out', 'booting']);
  const verdict = usePasskeyVerdict();
  return (
    <WelcomeFrame>
      <main id="main" className="flow">
        <p className="eyebrow">Sign in</p>
        <h1 className="welcome-h1">Your passkey is your key.</h1>
        <p className="page-lede" style={{ marginBottom: 28 }}>
          Choose your Vexa passkey when your browser asks. Your balance is decrypted on this device.
        </p>
        <div className="stack">
          <SignInButton />
          <Link href="/signup/" className="btn btn-secondary">
            New here? Create an account
          </Link>
          <PasskeyExplainer verdict={verdict} />
        </div>
      </main>
    </WelcomeFrame>
  );
}
