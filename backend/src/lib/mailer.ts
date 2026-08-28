// Outbound email via SMTP (our self-hosted Zimbra instance). Used for project
// collaborator invitations. Mirrors the "null when unconfigured" pattern of
// resolveLdapConfig() in ldap.ts — when SMTP env is absent, callers no-op rather
// than throw, so the app runs fine without email configured.
//
// Config (see .env.example):
//   SMTP_HOST    e.g. mail.yourdomain.com (Zimbra MTA)
//   SMTP_PORT    default 587 (STARTTLS submission)
//   SMTP_SECURE  "true" for implicit TLS (port 465); default false (STARTTLS)
//   SMTP_USER / SMTP_PASS  auth credentials (optional for an open relay)
//   SMTP_FROM    From header, e.g. "Mike <no-reply@yourdomain.com>"

import nodemailer, { type Transporter } from "nodemailer";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | undefined;
  pass: string | undefined;
  from: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Inline (Content-ID) attachments referenced from `html` as `cid:<cid>` —
   * used for the branded logo. See lib/email/layout.ts.
   */
  attachments?: {
    filename: string;
    content: string;
    encoding: "base64";
    cid: string;
    contentDisposition: "inline";
  }[];
}

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function resolveSmtpConfig(): SmtpConfig | null {
  const host = env("SMTP_HOST");
  const from = env("SMTP_FROM");
  // Host + From are the minimum required to send meaningful mail.
  if (!host || !from) return null;
  return {
    host,
    port: Number(env("SMTP_PORT") ?? "587"),
    secure: (env("SMTP_SECURE") ?? "false").toLowerCase() === "true",
    user: env("SMTP_USER"),
    pass: env("SMTP_PASS"),
    from,
  };
}

export function smtpEnabled(): boolean {
  return resolveSmtpConfig() !== null;
}

// Cache the transporter across sends. Keyed on a snapshot of the resolved config
// so a changed env (e.g. between tests) rebuilds it rather than reusing stale
// credentials.
let cachedTransporter: Transporter | null = null;
let cachedKey = "";

function getTransporter(cfg: SmtpConfig): Transporter {
  const key = JSON.stringify(cfg);
  if (cachedTransporter && cachedKey === key) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  cachedKey = key;
  return cachedTransporter;
}

/**
 * Verify SMTP connectivity + auth without sending mail (transporter.verify()).
 * Throws if SMTP is not configured or the handshake fails.
 */
export async function verifySmtp(): Promise<void> {
  const cfg = resolveSmtpConfig();
  if (!cfg) throw new Error("SMTP is not configured");
  await getTransporter(cfg).verify();
}

/**
 * Send a single email. Throws if SMTP is not configured or the send fails —
 * callers that treat mail as best-effort should wrap this in try/catch.
 */
export async function sendMail(msg: MailMessage): Promise<void> {
  const cfg = resolveSmtpConfig();
  if (!cfg) throw new Error("SMTP is not configured");
  await getTransporter(cfg).sendMail({
    from: cfg.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    attachments: msg.attachments,
  });
}
