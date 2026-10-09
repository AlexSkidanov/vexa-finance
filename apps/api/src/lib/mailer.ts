/**
 * Transactional email. Supabase's built-in sender is for development only: it
 * delivers to project members and a few messages an hour. Production sends
 * through Resend with Vexa's own templates and a vexa.finance sender.
 */
export interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

export function createResendMailer(opts: {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
}): Mailer {
  const doFetch = opts.fetch ?? fetch;
  return {
    async send(email) {
      const res = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ from: opts.from, ...email, to: [email.to] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // Resend's error body names the problem (unverified domain, bad key)
        // and never echoes the message, so it's safe to log.
        const detail = await res.text().catch(() => '');
        throw new Error(`resend ${res.status}: ${detail.slice(0, 300)}`);
      }
    },
  };
}
