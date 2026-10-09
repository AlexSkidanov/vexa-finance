/**
 * Vexa needs a passkey whose authenticator supports the WebAuthn PRF
 * extension: its output is the secret every key derives from. Browsers can
 * say up front whether they do (getClientCapabilities); older ones can't, and
 * we only find out when the first sign-in returns no PRF output.
 */

export interface PasskeyCapabilities {
  webauthn: boolean;
  /** A built-in authenticator (Touch ID, Windows Hello, Android) is available. */
  platform: boolean | null;
  /** The browser reports the PRF extension; null when it can't say. */
  prf: boolean | null;
}

export type PasskeyVerdict = 'supported' | 'likely' | 'unsupported';

export function passkeyVerdict(c: PasskeyCapabilities): PasskeyVerdict {
  if (!c.webauthn || c.prf === false) return 'unsupported';
  if (c.prf === true) return 'supported';
  return 'likely';
}

export async function detectPasskeySupport(): Promise<PasskeyCapabilities> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential || !navigator.credentials) {
    return { webauthn: false, platform: false, prf: false };
  }
  const PKC = window.PublicKeyCredential as typeof PublicKeyCredential & {
    getClientCapabilities?: () => Promise<Record<string, boolean>>;
  };
  let prf: boolean | null = null;
  try {
    const caps = await PKC.getClientCapabilities?.();
    if (caps && 'extension:prf' in caps) prf = caps['extension:prf'] === true;
  } catch {
    prf = null;
  }
  const platform = await PKC.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => null);
  return { webauthn: true, platform, prf };
}

export const SUPPORTED_PASSKEYS = [
  'iCloud Keychain on Safari 18 or later (macOS 15, iOS 18)',
  'Google Password Manager on Chrome 132 or later (desktop and Android)',
  '1Password, in its browser extension',
  'Bitwarden, in its browser extension',
  'A hardware security key with hmac-secret (YubiKey 5 and newer)',
];
