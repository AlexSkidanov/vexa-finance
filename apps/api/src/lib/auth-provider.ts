import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Session } from '@vexa/core';

export interface AuthProvider {
  sendEmailOtp(email: string): Promise<void>;
  /** Null if the code is wrong or expired. */
  verifyEmailOtp(email: string, token: string): Promise<Session | null>;
  refresh(refreshToken: string): Promise<Session | null>;
  /**
   * Issues a Supabase session for a user who just proved themselves with a
   * passkey. Supabase has no "sign in as this user" call, so we mint a one-time
   * magic-link token with the admin API and redeem it server-side. The token
   * never leaves this process.
   */
  sessionForUser(userId: string): Promise<Session>;
  getEmail(userId: string): Promise<string | null>;
}

export function createSupabaseAuthProvider(opts: {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}): AuthProvider {
  const clientOpts = { auth: { persistSession: false, autoRefreshToken: false } } as const;
  // A fresh anon client per call: supabase-js keeps the last session in the
  // client instance, and we never want one user's session visible to the next.
  const anon = (): SupabaseClient => createClient(opts.url, opts.anonKey, clientOpts);
  const admin = createClient(opts.url, opts.serviceRoleKey, clientOpts);

  const toSession = (s: {
    access_token: string;
    refresh_token: string;
    expires_at?: number;
    expires_in: number;
    user: { id: string; email?: string };
  }): Session => ({
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    expiresAt: s.expires_at ?? Math.floor(Date.now() / 1000) + s.expires_in,
    user: { id: s.user.id, email: s.user.email ?? null },
  });

  const getEmail = async (userId: string): Promise<string | null> => {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) return null;
    return data.user.email ?? null;
  };

  return {
    async sendEmailOtp(email) {
      const { error } = await anon().auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) throw error;
    },

    async verifyEmailOtp(email, token) {
      const { data, error } = await anon().auth.verifyOtp({ email, token, type: 'email' });
      if (error || !data.session) return null;
      return toSession(data.session);
    },

    async refresh(refreshToken) {
      const { data, error } = await anon().auth.refreshSession({ refresh_token: refreshToken });
      if (error || !data.session) return null;
      return toSession(data.session);
    },

    async sessionForUser(userId) {
      const email = await getEmail(userId);
      if (!email) throw new Error('user has no email');
      const { data: link, error: linkError } = await admin.auth.admin.generateLink({
        type: 'magiclink',
        email,
      });
      if (linkError) throw linkError;
      const { data, error } = await anon().auth.verifyOtp({
        token_hash: link.properties.hashed_token,
        type: 'magiclink',
      });
      if (error || !data.session) throw error ?? new Error('could not redeem session token');
      return toSession(data.session);
    },

    getEmail,
  };
}
