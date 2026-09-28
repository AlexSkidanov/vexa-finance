import { Hono } from 'hono';
import { formatHandle, type Profile } from '@vexa/core';
import { notFound } from '../errors.js';
import type { AppBindings } from '../context.js';
import { authenticate, principalOf } from '../middleware/auth.js';
import type { ProfileRow } from '../store/types.js';

export function profileJson(p: ProfileRow, email: string | null): Profile {
  return {
    userId: p.userId,
    email,
    handle: p.handle ? formatHandle(p.handle) : null,
    solanaPubkey: p.solanaPubkey,
    elgamalPubkey: p.elgamalPubkey,
    kycStatus: p.kycStatus,
    tier: p.tier,
    createdAt: p.createdAt.toISOString(),
  };
}

export const me = new Hono<AppBindings>().get('/', authenticate(), async (c) => {
  const { store } = c.get('deps');
  const principal = principalOf(c);
  const profile = await store.profiles.get(principal.userId);
  if (!profile) throw notFound('Profile');
  return c.json(profileJson(profile, principal.email));
});
