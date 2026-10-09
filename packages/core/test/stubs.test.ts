import { describe, expect, it } from 'vitest';
import { createMockCardIssuer, createMockKycProvider } from '../src/index.js';

describe('card and KYC stubs', () => {
  it('issues, limits and closes mock cards', async () => {
    const cards = createMockCardIssuer();
    const card = await cards.create({ ownerId: 'u1', monthlyLimit: 500_000_000n });
    expect(card).toMatchObject({ status: 'active', last4: expect.stringMatching(/^\d{4}$/) });
    await cards.setLimit(card.id, 100_000_000n);
    await cards.setStatus(card.id, 'closed');
    await expect(cards.setStatus(card.id, 'active')).rejects.toThrow(/closed/);
    expect(await cards.list('u1')).toHaveLength(1);
  });

  it('approves mock KYC sessions', async () => {
    const kyc = createMockKycProvider();
    const session = await kyc.start({ userId: 'u1', email: null });
    expect((await kyc.get(session.id))?.status).toBe('approved');
  });
});
