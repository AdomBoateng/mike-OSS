// Branded HTML shell shared by every outbound email.
//
// Email clients are not browsers: Outlook renders through Word, Gmail strips
// <style> in some views, and none of them reliably support flexbox/grid. So the
// layout below is deliberately old-fashioned — nested tables, inline styles,
// fixed 600px width — which is the combination that survives everywhere. Prefer
// extending renderEmail() over hand-writing HTML in a new template.

import {
  LOGO_CID,
  LOGO_FILENAME,
  LOGO_HEIGHT,
  LOGO_PNG_BASE64,
  LOGO_WIDTH,
} from "./logo";

// Quantum Group brand palette, sampled from quantumgroupgh.com.
const BRAND = {
  purple: "#671A55",
  purpleDark: "#3D0831",
  ink: "#313131",
  muted: "#6B6B6B",
  hairline: "#E7E3E6",
  canvas: "#F4F1F3",
} as const;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmailAttachment {
  filename: string;
  content: string;
  encoding: "base64";
  cid: string;
  contentDisposition: "inline";
}

/** The inline logo attachment every rendered email must be sent with. */
export function emailAttachments(): EmailAttachment[] {
  return [
    {
      filename: LOGO_FILENAME,
      content: LOGO_PNG_BASE64,
      encoding: "base64",
      cid: LOGO_CID,
      contentDisposition: "inline",
    },
  ];
}

export interface RenderEmailOptions {
  /** Big line at the top of the card. */
  heading: string;
  /**
   * Hidden one-liner used as the inbox preview text. Without it, clients fall
   * back to scraping the first visible text, which here would be the alt text
   * of the logo.
   */
  preheader: string;
  /** Body paragraphs, already escaped; rendered in order. */
  paragraphs: string[];
  /** Optional primary call-to-action button. */
  cta?: { label: string; url: string };
  /**
   * Shown small and grey under the button — e.g. the raw URL for clients that
   * refuse to render the button, or a "contact your administrator" note.
   */
  footNote?: string;
}

/**
 * Render the branded HTML for one email. Returns HTML only; pair it with
 * `emailAttachments()` so the `cid:` logo reference resolves.
 */
export function renderEmail(opts: RenderEmailOptions): string {
  const paragraphs = opts.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${BRAND.ink};">${p}</p>`,
    )
    .join("");

  // Bulletproof-ish button: a padded anchor. Outlook ignores border-radius and
  // renders a square button, which is an acceptable degradation.
  const cta = opts.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">
            <tr>
              <td align="center" bgcolor="${BRAND.purple}" style="border-radius:6px;">
                <a href="${escapeHtml(opts.cta.url)}"
                   style="display:inline-block;padding:13px 28px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;line-height:20px;color:#FFFFFF;text-decoration:none;border-radius:6px;">
                  ${escapeHtml(opts.cta.label)}
                </a>
              </td>
            </tr>
          </table>`
    : "";

  const footNote = opts.footNote
    ? `<p style="margin:20px 0 0;font-size:13px;line-height:20px;color:${BRAND.muted};word-break:break-word;">${opts.footNote}</p>`
    : "";

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(opts.heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.canvas};">
  <div style="display:none;font-size:1px;color:${BRAND.canvas};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(opts.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.canvas};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:#FFFFFF;border-radius:10px;overflow:hidden;border:1px solid ${BRAND.hairline};">
          <!-- Header -->
          <tr>
            <td align="left" bgcolor="${BRAND.purple}" style="padding:24px 32px;background-color:${BRAND.purple};">
              <img src="cid:${LOGO_CID}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="Quantum Group"
                   style="display:block;border:0;outline:none;text-decoration:none;width:${LOGO_WIDTH}px;height:${LOGO_HEIGHT}px;" />
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td align="left" style="padding:32px;font-family:Helvetica,Arial,sans-serif;">
              <h1 style="margin:0 0 18px;font-size:21px;line-height:29px;font-weight:600;color:${BRAND.purpleDark};">${escapeHtml(opts.heading)}</h1>
              ${paragraphs}
              ${cta}
              ${footNote}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="left" style="padding:20px 32px 26px;border-top:1px solid ${BRAND.hairline};font-family:Helvetica,Arial,sans-serif;">
              <p style="margin:0;font-size:12px;line-height:18px;color:${BRAND.muted};">
                Sent by <strong style="color:${BRAND.ink};font-weight:600;">Mike</strong>, the Quantum Group legal document assistant.
              </p>
              <p style="margin:6px 0 0;font-size:12px;line-height:18px;color:${BRAND.muted};">
                You received this because someone shared work with your address. This is an automated message &mdash; replies are not monitored.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
