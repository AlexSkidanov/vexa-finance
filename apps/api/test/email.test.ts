import { describe, expect, it } from 'vitest';
import { signInCodeEmail } from '../src/lib/emails.js';
import { createResendMailer } from '../src/lib/mailer.js';

describe('sign-in code email', () => {
  it('puts the code in the subject, the HTML and the plain-text part', () => {
    const email = signInCodeEmail('ada@example.com', '482913');
    expect(email.to).toBe('ada@example.com');
    expect(email.subject).toBe('482913 is your Vexa code');
    expect(email.html).toContain('482913');
    expect(email.html).toContain('https://vexa.finance/email/vexa-mark.png');
    expect(email.text).toContain('Your Vexa code is 482913');
  });

  it('refuses anything that is not a numeric code', () => {
    expect(() => signInCodeEmail('ada@example.com', '<b>1</b>')).toThrow();
    expect(() => signInCodeEmail('ada@example.com', '')).toThrow();
  });
});

describe('Resend mailer', () => {
  it('posts the message with the configured sender', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mailer = createResendMailer({
      apiKey: 're_test',
      from: 'Vexa <verify@vexa.finance>',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('{"id":"x"}', { status: 200 });
      }) as typeof fetch,
    });
    await mailer.send(signInCodeEmail('ada@example.com', '123456'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.from).toBe('Vexa <verify@vexa.finance>');
    expect(body.to).toEqual(['ada@example.com']);
  });

  it('throws when Resend rejects the message', async () => {
    const mailer = createResendMailer({
      apiKey: 're_test',
      from: 'Vexa <verify@vexa.finance>',
      fetch: (async () =>
        new Response('{"message":"domain not verified"}', { status: 403 })) as typeof fetch,
    });
    await expect(mailer.send(signInCodeEmail('ada@example.com', '123456'))).rejects.toThrow(
      /resend 403: .*domain not verified/,
    );
  });
});
