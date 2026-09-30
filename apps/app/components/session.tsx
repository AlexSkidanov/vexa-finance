'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Profile, Unlocked, VexaClient } from '@/lib/client';
import { DEMO_AVAILABLE } from '@/lib/config';

/**
 * Where the user is:
 * - signed-out: no session
 * - needs-passkey: signed in with the email code, no passkey yet
 * - locked: a session, but the keys aren't in memory (after a reload, or locked)
 * - onboarding: keys in memory, handle or account still to set up
 * - ready: everything works
 */
export type Phase = 'booting' | 'signed-out' | 'needs-passkey' | 'locked' | 'onboarding' | 'ready';

interface SessionValue {
  phase: Phase;
  client: VexaClient | null;
  profile: Profile | null;
  demo: boolean;
  /** Set after a successful passkey unlock. */
  unlocked: (u: Unlocked) => void;
  setProfile: (p: Profile) => void;
  /** Re-reads where the user is from the client (after sign-up steps). */
  sync: () => void;
  accountOpened: () => void;
  lock: () => void;
  signOut: (reason?: 'expired') => void;
  startDemo: () => void;
  exitDemo: () => void;
  signedOutReason: 'expired' | null;
}

const Ctx = createContext<SessionValue | null>(null);

const DEMO_FLAG = 'vexa.demo';
/** Keys leave memory when the tab has been in the background this long. */
const LOCK_AFTER_HIDDEN_MS = 10 * 60_000;

function demoRequested(): boolean {
  if (!DEMO_AVAILABLE) return false;
  try {
    if (new URLSearchParams(window.location.search).get('demo') === '1') {
      sessionStorage.setItem(DEMO_FLAG, '1');
      return true;
    }
    return sessionStorage.getItem(DEMO_FLAG) === '1';
  } catch {
    return false;
  }
}

async function makeClient(demo: boolean): Promise<VexaClient> {
  if (DEMO_AVAILABLE && demo) {
    const { createDemoClient } = await import('@/lib/demo-client');
    return createDemoClient();
  }
  const { createRealClient } = await import('@/lib/real-client');
  return createRealClient();
}

function phaseOf(client: VexaClient, profile: Profile | null, accountOpen: boolean): Phase {
  if (!client.hasSession()) return 'signed-out';
  if (!client.isUnlocked()) return client.hasPasskey() ? 'locked' : 'needs-passkey';
  if (!profile?.handle || !accountOpen) return 'onboarding';
  return 'ready';
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<VexaClient | null>(null);
  const [demo, setDemo] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('booting');
  const [signedOutReason, setReason] = useState<'expired' | null>(null);

  const boot = useCallback(async (wantDemo: boolean) => {
    setPhase('booting');
    const c = await makeClient(wantDemo);
    setDemo(c.demo);
    setClient(c);
    setProfile(null);
    setAccountOpen(false);
    setPhase(phaseOf(c, null, false));
  }, []);

  useEffect(() => {
    void boot(demoRequested());
  }, [boot]);

  // Lock after a long time in the background.
  const hiddenAt = useRef<number | null>(null);
  useEffect(() => {
    if (!client) return;
    const onVis = () => {
      if (document.visibilityState === 'hidden') hiddenAt.current = Date.now();
      else if (hiddenAt.current && Date.now() - hiddenAt.current > LOCK_AFTER_HIDDEN_MS) {
        if (client.isUnlocked()) {
          client.lock();
          setPhase(phaseOf(client, null, false));
        }
        hiddenAt.current = null;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [client]);

  const value = useMemo<SessionValue>(
    () => ({
      phase,
      client,
      profile,
      demo,
      signedOutReason,
      unlocked: (u) => {
        setProfile(u.profile);
        setAccountOpen(u.accountOpen);
        setReason(null);
        if (client) setPhase(phaseOf(client, u.profile, u.accountOpen));
      },
      setProfile: (p) => {
        setProfile(p);
        if (client) setPhase(phaseOf(client, p, accountOpen));
      },
      sync: () => {
        if (client) setPhase(phaseOf(client, profile, accountOpen));
      },
      accountOpened: () => {
        setAccountOpen(true);
        if (client) setPhase(phaseOf(client, profile, true));
      },
      lock: () => {
        client?.lock();
        if (client) setPhase(phaseOf(client, null, false));
      },
      signOut: (reason) => {
        client?.signOut();
        setProfile(null);
        setAccountOpen(false);
        setReason(reason ?? null);
        setPhase('signed-out');
      },
      startDemo: () => {
        try {
          sessionStorage.setItem(DEMO_FLAG, '1');
        } catch {
          // demo still starts, it just won't survive a reload
        }
        void boot(true);
      },
      exitDemo: () => {
        client?.signOut();
        try {
          sessionStorage.removeItem(DEMO_FLAG);
        } catch {
          // nothing to clear
        }
        void boot(false);
      },
    }),
    [phase, client, profile, demo, accountOpen, signedOutReason, boot],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** For screens behind the shell: the client, which is unlocked and set up. */
export function useClient(): VexaClient {
  const { client } = useSession();
  if (!client) throw new Error('no client yet');
  return client;
}

const RETURN_KEY = 'vexa.returnTo';

/**
 * Sends the user where their phase says they belong. A signed-in page opened
 * while locked comes back after unlocking.
 */
export function usePhaseRedirect(allowed: Phase[]) {
  const { phase } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const key = allowed.join();
  useEffect(() => {
    if (phase === 'booting' || key.split(',').includes(phase)) return;
    let to =
      phase === 'ready'
        ? '/home/'
        : phase === 'needs-passkey' || phase === 'onboarding'
          ? '/signup/'
          : '/';
    try {
      if (phase === 'ready') {
        const back = sessionStorage.getItem(RETURN_KEY);
        sessionStorage.removeItem(RETURN_KEY);
        if (back?.startsWith('/')) to = back;
      } else if (phase === 'locked' && key === 'ready') {
        sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);
      }
    } catch {
      // no storage: land on Home
    }
    if (to.replace(/\/$/, '') !== pathname.replace(/\/$/, '')) router.replace(to);
  }, [phase, key, router, pathname]);
  return phase;
}
