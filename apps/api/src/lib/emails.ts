import type { Email } from './mailer.js';

/**
 * Vexa's email templates, styled like vexa.finance: Vault background,
 * hairline borders, Chivo Mono labels and Signal green for the one thing to
 * act on. Emails get inline styles, table layout and bgcolor attributes only,
 * because that is all Gmail and Outlook reliably render. Brand colours from
 * the brand kit: Vault #0A0A0B, Paper #F2F2F2, Signal #3DE6A5, Ash #A8A8AD,
 * Moss #6B6B70, hairline #2A2A2F.
 */
const SITE = 'https://vexa.finance';
const MARK_URL = `${SITE}/email/vexa-mark-dark.png`;

const VAULT = '#0A0A0B';
const PAPER = '#F2F2F2';
const BODY = '#D2D2D6';
const ASH = '#A8A8AD';
const MOSS = '#6B6B70';
const HAIR = '#2A2A2F';
const SIGNAL = '#3DE6A5';

const SANS = "Afacad, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'Chivo Mono', 'SFMono-Regular', Menlo, Consolas, monospace";

function layout(opts: { preheader: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<link href="https://fonts.googleapis.com/css2?family=Afacad:wght@400;600&family=Chivo+Mono:wght@400;500&display=swap" rel="stylesheet">
<title>Vexa</title>
</head>
<body bgcolor="${VAULT}" style="margin:0;padding:0;background:${VAULT};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${opts.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${VAULT}" style="background:${VAULT};">
<tr><td align="center" style="padding:44px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="padding:0 0 28px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle;"><img src="${MARK_URL}" width="23" height="28" alt="" style="display:block;border:0;"></td>
<td style="vertical-align:middle;padding-left:10px;font:600 28px/1 ${SANS};letter-spacing:-1.3px;color:${PAPER};">vexa</td>
</tr></table>
</td></tr>
<tr><td bgcolor="${VAULT}" style="background:${VAULT};border:1px solid ${HAIR};padding:36px 32px;">
${opts.body}
</td></tr>
<tr><td style="padding:24px 0 0;font:400 13px/1.6 ${SANS};color:${MOSS};">
The fully private neobank on Solana, secured by NEAR and ZEC.<br>
<a href="${SITE}" style="color:${ASH};text-decoration:none;">vexa.finance</a> &nbsp;·&nbsp; <a href="${SITE}/security/" style="color:${ASH};text-decoration:none;">Security</a> &nbsp;·&nbsp; <a href="${SITE}/privacy/" style="color:${ASH};text-decoration:none;">Privacy</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The six-digit code that verifies an email address at sign-up and sign-in. */
export function signInCodeEmail(to: string, code: string): Email {
  if (!/^\d{6,10}$/.test(code)) throw new Error('sign-in code must be digits');
  const body = `
<p style="margin:0 0 18px;font:400 12px/1.2 ${MONO};letter-spacing:1.2px;text-transform:uppercase;color:${ASH};">Sign-in code</p>
<h1 style="margin:0 0 12px;font:600 30px/1.15 ${SANS};letter-spacing:-0.6px;color:${PAPER};">Your Vexa code</h1>
<p style="margin:0 0 28px;font:400 17px/1.5 ${SANS};color:${BODY};">Enter this code to verify your email and continue to Vexa.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td align="center" bgcolor="${VAULT}" style="background:${VAULT};border:1px solid ${HAIR};padding:26px 12px;font:400 40px/1 ${MONO};letter-spacing:12px;color:${SIGNAL};">${code}</td>
</tr></table>
<p style="margin:28px 0 0;font:400 15px/1.55 ${SANS};color:${MOSS};">The code works once. Vexa will never ask you for it by phone, chat or email. If you didn't request it, you can ignore this message and nothing will change.</p>`;
  return {
    to,
    subject: `${code} is your Vexa code`,
    html: layout({ preheader: `Your Vexa code is ${code}`, body }),
    text: [
      `Your Vexa code is ${code}`,
      '',
      'Enter this code to verify your email and continue to Vexa.',
      'The code works once. Vexa will never ask you for it by phone, chat or email.',
      "If you didn't request it, you can ignore this message.",
      '',
      SITE,
    ].join('\n'),
  };
}
