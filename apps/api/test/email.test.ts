import { describe, expect, it } from 'vitest';
import { signInCodeEmail } from '../src/lib/emails.js';
import { createSmtpMailer, MailDeliveryError } from '../src/lib/mailer.js';

describe('sign-in code email', () => {
  it('puts the code in the subject, the HTML and the plain-text part', () => {
    const email = signInCodeEmail('ada@example.com', '482913');
    expect(email.to).toBe('ada@example.com');
    expect(email.subject).toBe('482913 is your Vexa code');
    expect(email.html).toContain('482913');
    expect(email.html).toContain('https://vexa.finance/email/vexa-mark-dark.png');
    expect(email.text).toContain('Your Vexa code is 482913');
  });

  it('refuses anything that is not a numeric code', () => {
    expect(() => signInCodeEmail('ada@example.com', '<b>1</b>')).toThrow();
    expect(() => signInCodeEmail('ada@example.com', '')).toThrow();
  });
});

describe('SMTP mailer', () => {
  it('reports a failed connection as a delivery error', async () => {
    // Nothing listens on port 1, so the connection is refused straight away.
    const mailer = createSmtpMailer({
      url: 'smtp://127.0.0.1:1',
      from: 'Vexa <verify@vexa.finance>',
    });
    const sent = mailer.send(signInCodeEmail('ada@example.com', '123456'));
    await expect(sent).rejects.toBeInstanceOf(MailDeliveryError);
    await expect(sent).rejects.toThrow(/^smtp: /);
  });
});
