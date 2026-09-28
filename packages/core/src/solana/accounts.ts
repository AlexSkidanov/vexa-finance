/**
 * Decoders for the Token-2022 state Vexa reads: a cUSDC account's confidential
 * balances and the mint's confidential-transfer settings. Pure functions over
 * raw account bytes, so the API, the SDK and the tests share them.
 */

const ACCOUNT_LEN = 165;
const EXT_CONFIDENTIAL_TRANSFER_MINT = 4;
const EXT_CONFIDENTIAL_TRANSFER_ACCOUNT = 5;

function* extensions(data: Uint8Array): Generator<[number, Uint8Array]> {
  let i = ACCOUNT_LEN + 1;
  while (i + 4 <= data.length) {
    const type = data[i]! | (data[i + 1]! << 8);
    const len = data[i + 2]! | (data[i + 3]! << 8);
    if (type === 0) return;
    yield [type, data.subarray(i + 4, i + 4 + len)];
    i += 4 + len;
  }
}

function findExtension(data: Uint8Array, type: number): Uint8Array | null {
  for (const [t, v] of extensions(data)) if (t === type) return v;
  return null;
}

const u64 = (b: Uint8Array, o: number) =>
  new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true);

/**
 * A cUSDC account's confidential state. Every balance here is a ciphertext:
 * ElGamal ciphertexts (64 bytes) decryptable with the owner's ElGamal key, and
 * the AE-encrypted available balance (36 bytes) decryptable with their AE key.
 */
export interface ConfidentialAccountState {
  owner: Uint8Array;
  /** Public (non-confidential) balance in base units. Normally 0. */
  publicAmount: bigint;
  approved: boolean;
  elgamalPubkey: Uint8Array;
  pendingBalanceLo: Uint8Array;
  pendingBalanceHi: Uint8Array;
  availableBalance: Uint8Array;
  decryptableAvailableBalance: Uint8Array;
  allowConfidentialCredits: boolean;
  allowNonConfidentialCredits: boolean;
  pendingBalanceCreditCounter: bigint;
  maximumPendingBalanceCreditCounter: bigint;
  expectedPendingBalanceCreditCounter: bigint;
  actualPendingBalanceCreditCounter: bigint;
}

/** Returns null if the account has no confidential-transfer extension yet. */
export function decodeConfidentialAccount(data: Uint8Array): ConfidentialAccountState | null {
  if (data.length <= ACCOUNT_LEN) return null;
  const ct = findExtension(data, EXT_CONFIDENTIAL_TRANSFER_ACCOUNT);
  if (!ct || ct.length < 295) return null;
  return {
    owner: data.slice(32, 64),
    publicAmount: u64(data, 64),
    approved: ct[0] === 1,
    elgamalPubkey: ct.slice(1, 33),
    pendingBalanceLo: ct.slice(33, 97),
    pendingBalanceHi: ct.slice(97, 161),
    availableBalance: ct.slice(161, 225),
    decryptableAvailableBalance: ct.slice(225, 261),
    allowConfidentialCredits: ct[261] === 1,
    allowNonConfidentialCredits: ct[262] === 1,
    pendingBalanceCreditCounter: u64(ct, 263),
    maximumPendingBalanceCreditCounter: u64(ct, 271),
    expectedPendingBalanceCreditCounter: u64(ct, 279),
    actualPendingBalanceCreditCounter: u64(ct, 287),
  };
}

export interface ConfidentialMintState {
  authority: Uint8Array;
  autoApproveNewAccounts: boolean;
  /** Null when the mint has no auditor (all-zero on-chain). */
  auditorElgamalPubkey: Uint8Array | null;
}

export function decodeConfidentialMint(data: Uint8Array): ConfidentialMintState | null {
  const ct = findExtension(data, EXT_CONFIDENTIAL_TRANSFER_MINT);
  if (!ct || ct.length < 65) return null;
  const auditor = ct.slice(33, 65);
  return {
    authority: ct.slice(0, 32),
    autoApproveNewAccounts: ct[32] === 1,
    auditorElgamalPubkey: auditor.every((b) => b === 0) ? null : auditor,
  };
}
