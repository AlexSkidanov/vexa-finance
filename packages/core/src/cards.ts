/**
 * Virtual cards: the interface Vexa's card program will implement, and a mock
 * for development. Nothing here moves money yet.
 *
 * TODO: implement with an issuer (Lithic or Rain). A card spends from the
 * user's confidential balance through a withdrawal to the issuer's funding
 * account at authorization time, so the card network sees a USD amount and
 * nobody sees the user's balance.
 */

export type CardStatus = 'active' | 'frozen' | 'closed';

export interface Card {
  id: string;
  ownerId: string;
  last4: string;
  expMonth: number;
  expYear: number;
  status: CardStatus;
  /** Spend limit per calendar month, USDC base units. */
  monthlyLimit: bigint;
  createdAt: Date;
}

export interface CardIssuer {
  create(input: { ownerId: string; monthlyLimit: bigint }): Promise<Card>;
  get(id: string): Promise<Card | null>;
  list(ownerId: string): Promise<Card[]>;
  setStatus(id: string, status: CardStatus): Promise<Card>;
  setLimit(id: string, monthlyLimit: bigint): Promise<Card>;
}

/** In-memory issuer for development and tests. Card numbers are never generated. */
export function createMockCardIssuer(): CardIssuer {
  const cards = new Map<string, Card>();
  const get = (id: string) => {
    const card = cards.get(id);
    if (!card) throw new Error(`no card ${id}`);
    return card;
  };
  return {
    async create({ ownerId, monthlyLimit }) {
      const now = new Date();
      const card: Card = {
        id: crypto.randomUUID(),
        ownerId,
        last4: String(Math.floor(1000 + Math.random() * 9000)),
        expMonth: now.getMonth() + 1,
        expYear: now.getFullYear() + 3,
        status: 'active',
        monthlyLimit,
        createdAt: now,
      };
      cards.set(card.id, card);
      return card;
    },
    async get(id) {
      return cards.get(id) ?? null;
    },
    async list(ownerId) {
      return [...cards.values()].filter((c) => c.ownerId === ownerId);
    },
    async setStatus(id, status) {
      const card = get(id);
      if (card.status === 'closed') throw new Error('a closed card stays closed');
      card.status = status;
      return card;
    },
    async setLimit(id, monthlyLimit) {
      const card = get(id);
      card.monthlyLimit = monthlyLimit;
      return card;
    },
  };
}
