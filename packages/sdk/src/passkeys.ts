/**
 * Browser helpers for WebAuthn with the PRF extension. The passkey signs the
 * user in, and its PRF output is the root secret that deriveUserKeys() turns
 * into the user's Solana and encryption keys, all without leaving the device.
 */

type Json = Record<string, unknown>;

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToB64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function assertBrowser() {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error('Passkeys require a browser with WebAuthn support');
  }
}

/** Runs navigator.credentials.create() for server-issued registration options. */
export async function createPasskey(options: Json): Promise<Json> {
  assertBrowser();
  const o = options as {
    challenge: string;
    user: { id: string; name: string; displayName: string };
    excludeCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
  } & Json;

  const credential = (await navigator.credentials.create({
    publicKey: {
      ...(o as unknown as PublicKeyCredentialCreationOptions),
      challenge: b64urlToBytes(o.challenge),
      user: { ...o.user, id: b64urlToBytes(o.user.id) },
      excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({
        ...c,
        id: b64urlToBytes(c.id),
      })) as PublicKeyCredentialDescriptor[],
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey creation was cancelled');

  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bytesToB64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: {},
    response: {
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      attestationObject: bytesToB64url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
  };
}

/**
 * Runs navigator.credentials.get() and evaluates PRF with `prfInput` in the
 * same ceremony. Returns the assertion for the server and the 32-byte PRF
 * output, which stays on the device.
 */
export async function getPasskeyAssertion(
  options: Json,
  prfInput: Uint8Array,
): Promise<{ assertion: Json; prfOutput: Uint8Array | null }> {
  assertBrowser();
  const o = options as { challenge: string } & Json;
  const credential = (await navigator.credentials.get({
    publicKey: {
      ...(o as unknown as PublicKeyCredentialRequestOptions),
      challenge: b64urlToBytes(o.challenge),
      extensions: {
        prf: { eval: { first: new Uint8Array(prfInput) } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey sign-in was cancelled');

  const response = credential.response as AuthenticatorAssertionResponse;
  const prf = (
    credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
  ).prf?.results?.first;

  return {
    prfOutput: prf ? new Uint8Array(prf) : null,
    assertion: {
      id: credential.id,
      rawId: bytesToB64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      // PRF results are deliberately not forwarded to the server.
      clientExtensionResults: {},
      response: {
        clientDataJSON: bytesToB64url(response.clientDataJSON),
        authenticatorData: bytesToB64url(response.authenticatorData),
        signature: bytesToB64url(response.signature),
        userHandle: response.userHandle ? bytesToB64url(response.userHandle) : undefined,
      },
    },
  };
}
