import type { Email } from './mailer.js';

/**
 * Vexa's email templates. Emails get inline styles and table layout only,
 * because that is all Gmail and Outlook reliably render. Brand colours from
 * the brand kit: Vault #0A0A0B, Paper #F2F2F2, Signal #3DE6A5, Moss #6B6B70.
 */
const SITE = 'https://vexa.finance';
const MARK_URL = `${SITE}/email/vexa-mark.png`;

const SANS = "Afacad, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'Chivo Mono', 'SFMono-Regular', Menlo, Consolas, monospace";

function layout(opts: { preheader: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Afacad:wght@400;600&family=Chivo+Mono:wght@500&display=swap" rel="stylesheet">
<title>Vexa</title>
</head>
<body style="margin:0;padding:0;background:#F2F2F2;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${opts.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F2F2;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
<tr><td style="padding:0 4px 24px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle;"><img src="${MARK_URL}" width="28" height="28" alt="" style="display:block;border:0;"></td>
<td style="vertical-align:middle;padding-left:10px;font:600 26px/1 ${SANS};letter-spacing:-1.2px;color:#0A0A0B;">vexa</td>
</tr></table>
</td></tr>
<tr><td style="background:#FFFFFF;border:1px solid #E4E4E7;border-radius:16px;padding:36px 32px;">
${opts.body}
</td></tr>
<tr><td style="padding:24px 4px 0;font:400 13px/1.5 ${SANS};color:#6B6B70;">
Vexa · the private neobank on Solana<br>
<a href="${SITE}" style="color:#6B6B70;">vexa.finance</a> · <a href="${SITE}/security/" style="color:#6B6B70;">Security</a> · <a href="${SITE}/privacy/" style="color:#6B6B70;">Privacy</a>
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
<h1 style="margin:0 0 12px;font:600 26px/1.2 ${SANS};letter-spacing:-0.5px;color:#0A0A0B;">Your Vexa code</h1>
<p style="margin:0 0 28px;font:400 17px/1.5 ${SANS};color:#3F3F46;">Enter this code to verify your email and continue to Vexa.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td align="center" style="background:#0A0A0B;border-radius:12px;padding:22px 12px;font:500 34px/1 ${MONO};letter-spacing:10px;color:#3DE6A5;">${code}</td>
</tr></table>
<p style="margin:28px 0 0;font:400 15px/1.5 ${SANS};color:#6B6B70;">The code works once. Vexa will never ask you for it by phone, chat or email. If you didn't request it, you can ignore this message and nothing will change.</p>`;
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
