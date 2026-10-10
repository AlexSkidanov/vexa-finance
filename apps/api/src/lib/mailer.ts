/**
 * Transactional email. Supabase's built-in sender is for development only: it
 * delivers to project members and a few messages an hour. Production sends
 * through Postmark with Vexa's own templates and a vexa.finance sender.
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
