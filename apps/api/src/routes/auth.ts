import { Hono } from 'hono';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  ErrorCode,
  PasskeyLoginOptionsRequest,
  PasskeyLoginVerifyRequest,
  PasskeyRegistrationVerifyRequest,
  RefreshSessionRequest,
  SendOtpRequest,
  VerifyOtpRequest,
} from '@vexa/core';
import { ApiError } from '../errors.js';
import type { AppBindings } from '../context.js';
import { authenticate, principalOf } from '../middleware/auth.js';
import { clientIp, rateLimit } from '../lib/rate-limit.js';
import { MailDeliveryError } from '../lib/mailer.js';
import { parseBody } from '../lib/validate.js';

/**
 * Sign-in is two steps.
 *
 * 1. Email OTP creates the account and proves the email address. Supabase
 *    issues a one-time numeric code and the API emails it over SMTP
 *    (see lib/auth-provider.ts); verifying it returns a session.
 * 2. With that session, the user registers a passkey. From then on they sign in
 *    with the passkey alone, and the same passkey's PRF output derives their
 *    wallet and encryption keys on-device (see @vexa/core/crypto).
 *
 * Every endpoint that returns a session is rate-limited per IP.
 */
const perIp = (max: number) =>
  rateLimit({ windowMs: 60_000, max, key: (c) => `${c.req.path}:${clientIp(c)}` });

const invalidPasskey = () =>
  new ApiError(401, ErrorCode.Unauthenticated, 'Passkey verification failed');

export const auth = new Hono<AppBindings>()
  // --- Email OTP ------------------------------------------------------------

  .post('/otp', perIp(5), async (c) => {
    const { email } = await parseBody(c, SendOtpRequest);
    try {
      await c.get('deps').auth.sendEmailOtp(email);
    } catch (err) {
      c.get('logger').warn({ err }, 'otp send failed');
      // A refused send says nothing about the address, so tell the user rather
      // than leave them waiting for an email that isn't coming.
      if (err instanceof MailDeliveryError) {
        throw new ApiError(
          503,
          ErrorCode.UpstreamUnavailable,
          "We couldn't send the email right now. Try again in a few minutes.",
        );
      }
      // Anything else answers the same way as success, so this endpoint can't
      // be used to probe which addresses have accounts.
    }
    return c.json({ sent: true }, 202);
  })

  .post('/otp/verify', perIp(10), async (c) => {
    const { email, token } = await parseBody(c, VerifyOtpRequest);
    const session = await c.get('deps').auth.verifyEmailOtp(email, token);
    if (!session)
      throw new ApiError(401, ErrorCode.Unauthenticated, 'Code is invalid or has expired');
    return c.json(session);
  })

  .post('/refresh', perIp(30), async (c) => {
    const { refreshToken } = await parseBody(c, RefreshSessionRequest);
    const session = await c.get('deps').auth.refresh(refreshToken);
    if (!session)
      throw new ApiError(401, ErrorCode.Unauthenticated, 'Refresh token is invalid or expired');
    return c.json(session);
  })

  // --- Passkey registration (requires a session) ------------------------------

  .post('/passkeys/register/options', authenticate({ sessionOnly: true }), async (c) => {
    const { env, store, auth: provider } = c.get('deps');
    const { userId, email } = principalOf(c);
    const existing = await store.passkeys.listForUser(userId);

    const options = await generateRegistrationOptions({
      rpName: env.WEBAUTHN_RP_NAME,
      rpID: env.WEBAUTHN_RP_ID,
      userName: email ?? (await provider.getEmail(userId)) ?? userId,
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({
        id: p.id,
        transports: p.transports as AuthenticatorTransport[],
      })),
      authenticatorSelection: {
        // Discoverable credentials let users sign in without typing an email first.
        residentKey: 'required',
        userVerification: 'required',
      },
      // Ask the authenticator to enable PRF. The SDK evaluates it at sign-in to
      // derive the user's keys; authenticators without PRF can still sign in
      // but can't hold funds.
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    });

    const challengeId = await store.passkeys.createChallenge({
      userId,
      kind: 'registration',
      challenge: options.challenge,
    });
    return c.json({ challengeId, options });
  })

  .post('/passkeys/register/verify', authenticate({ sessionOnly: true }), async (c) => {
    const { env, store } = c.get('deps');
    const { userId } = principalOf(c);
    const body = await parseBody(c, PasskeyRegistrationVerifyRequest);

    const challenge = await store.passkeys.consumeChallenge(body.challengeId, 'registration');
    if (!challenge || challenge.userId !== userId) throw invalidPasskey();

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: env.WEBAUTHN_ORIGINS,
        expectedRPID: env.WEBAUTHN_RP_ID,
        requireUserVerification: true,
      });
    } catch (err) {
      c.get('logger').info({ err }, 'passkey registration rejected');
      throw invalidPasskey();
    }
    if (!verification.verified) throw invalidPasskey();

    const info = verification.registrationInfo;
    await store.passkeys.insert({
      id: info.credential.id,
      userId,
      name: body.name ?? null,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    });
    return c.json({ id: info.credential.id, backedUp: info.credentialBackedUp }, 201);
  })

  // --- Passkey sign-in ------------------------------------------------------

  .post('/passkeys/login/options', perIp(20), async (c) => {
    const { env, store } = c.get('deps');
    await parseBody(c, PasskeyLoginOptionsRequest);
    // No allowCredentials: the browser offers whichever discoverable passkey
    // the user has for this site. That also means we never reveal whether an
    // email has passkeys registered.
    const options = await generateAuthenticationOptions({
      rpID: env.WEBAUTHN_RP_ID,
      userVerification: 'required',
    });
    const challengeId = await store.passkeys.createChallenge({
      userId: null,
      kind: 'authentication',
      challenge: options.challenge,
    });
    return c.json({ challengeId, options });
  })

  .post('/passkeys/login/verify', perIp(20), async (c) => {
    const { env, store, auth: provider } = c.get('deps');
    const { challengeId, response } = await parseBody(c, PasskeyLoginVerifyRequest);
    const assertion = response as unknown as AuthenticationResponseJSON;

    const challenge = await store.passkeys.consumeChallenge(challengeId, 'authentication');
    if (!challenge) throw invalidPasskey();
    const passkey =
      typeof assertion.id === 'string' ? await store.passkeys.get(assertion.id) : null;
    if (!passkey) throw invalidPasskey();

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: challenge.challenge,
        expectedOrigin: env.WEBAUTHN_ORIGINS,
        expectedRPID: env.WEBAUTHN_RP_ID,
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: passkey.publicKey,
          counter: passkey.counter,
          transports: passkey.transports as AuthenticatorTransport[],
        },
      });
    } catch (err) {
      c.get('logger').info({ err }, 'passkey assertion rejected');
      throw invalidPasskey();
    }
    if (!verification.verified) throw invalidPasskey();

    await store.passkeys.markUsed(passkey.id, verification.authenticationInfo.newCounter);
    const session = await provider.sessionForUser(passkey.userId);
    return c.json(session);
  });
