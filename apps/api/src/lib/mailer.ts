import { createTransport } from 'nodemailer';

/**
 * Transactional email. Supabase's built-in sender is for development only: it
 * delivers to project members and a few messages an hour. Production sends
 * Vexa's own templates from a vexa.finance address, through Postmark or any
 * SMTP server (Fastmail, for example, while a Postmark account awaits
 * approval).
 */
export interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * The provider refused or failed to take the message. It says nothing about
 * the recipient's account, so callers can report it to the user.
 */
export class MailDeliveryError extends Error {
  override name = 'MailDeliveryError';
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

export function createPostmarkMailer(opts: {
  serverToken: string;
  from: string;
  fetch?: typeof fetch;
}): Mailer {
  const doFetch = opts.fetch ?? fetch;
  return {
    async send(email) {
      const res = await doFetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-postmark-server-token': opts.serverToken,
        },
        body: JSON.stringify({
          From: opts.from,
          To: email.to,
          Subject: email.subject,
          HtmlBody: email.html,
          TextBody: email.text,
          MessageStream: 'outbound',
          // Sign-in codes are one-off messages: no open or link tracking.
          TrackOpens: false,
          TrackLinks: 'None',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // Postmark's error body names the problem (unconfirmed sender, bad
        // token) and never echoes the message, so it's safe to log.
        const detail = await res.text().catch(() => '');
        throw new MailDeliveryError(`postmark ${res.status}: ${detail.slice(0, 300)}`);
      }
    },
  };
}

/**
 * Sends through an SMTP server given as a URL, e.g.
 * smtps://user%40vexa.finance:app-password@smtp.fastmail.com:465. The
 * From address must be one the server lets the account send as.
 */
export function createSmtpMailer(opts: { url: string; from: string }): Mailer {
  const url = new URL(opts.url);
  const secure = url.protocol === 'smtps:';
  const transport = createTransport({
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    auth: url.username
      ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(email) {
      try {
        await transport.sendMail({
          from: opts.from,
          to: email.to,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      } catch (err) {
        // nodemailer's message names the SMTP failure (auth, rejected sender)
        // and never includes the body or the password.
        const message = err instanceof Error ? err.message : String(err);
        throw new MailDeliveryError(`smtp: ${message.slice(0, 300)}`);
      }
    },
  };
}
