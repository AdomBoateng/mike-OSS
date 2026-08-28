// Emails project collaborators when they are added to a project.
//
// Two audiences (per product decision):
//   - Already an app user  -> a light "you've been added to <project>" notice.
//   - Not an app user, but present in the LDAP directory -> an invitation telling
//     them to sign in with their LDAP credentials to access the project.
//   - Neither (unknown address) -> skipped with a warning; they cannot sign in.
//
// All sends are best-effort: a failure (or missing SMTP config) never blocks the
// share that triggered it. Callers fire-and-forget.

import { getAuthUserByEmail } from "./authUsers";
import { ldapFindByEmail } from "./ldap";
import { sendMail, smtpEnabled } from "./mailer";
import {
  emailAttachments,
  escapeHtml,
  renderEmail,
  type EmailAttachment,
} from "./email/layout";

export interface NotifyOptions {
  projectId: string;
  projectName: string;
  /** Human label for who did the sharing (display name or email). */
  inviterLabel: string;
  /** Newly-added collaborator emails (already normalised/lowercased). */
  newEmails: string[];
}

/**
 * Base URL to link to from emails.
 *
 * FRONTEND_URL is a CORS *allowlist*, not a single address: it may be a
 * comma-separated list, and docker-compose sets it to "*" to reflect any origin
 * for LAN access. Either of those would produce a dead link in an email, so
 * prefer the explicit APP_PUBLIC_URL and fall back to the first usable entry of
 * FRONTEND_URL.
 */
function frontendUrl(): string {
  const explicit = process.env.APP_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const candidate = (process.env.FRONTEND_URL ?? "")
    .split(",")
    .map((o) => o.trim())
    .find((o) => o && o !== "*" && /^https?:\/\//i.test(o));

  return (candidate || "http://localhost:3000").replace(/\/+$/, "");
}

export interface Template {
  subject: string;
  text: string;
  html: string;
  attachments: EmailAttachment[];
}

/**
 * Sent to someone who has never signed in: they get the sign-in URL and an
 * explanation that their existing directory credentials are the way in — there
 * is no account to create.
 */
export function invitationEmail(opts: NotifyOptions): Template {
  const url = frontendUrl();
  const project = opts.projectName;
  const subject = `${opts.inviterLabel} invited you to collaborate on "${project}"`;
  const text =
    `${opts.inviterLabel} has invited you to collaborate on the project "${project}" in Mike.\n\n` +
    `Mike is Quantum Group's legal document assistant. Sign in with your usual ` +
    `directory (LDAP) username and password — there is no separate account to create:\n${url}\n\n` +
    `If you do not have directory credentials, contact your administrator.`;
  const html = renderEmail({
    heading: "You've been invited to collaborate",
    preheader: `${opts.inviterLabel} invited you to "${project}" in Mike.`,
    paragraphs: [
      `<strong>${escapeHtml(opts.inviterLabel)}</strong> has invited you to collaborate on the project &ldquo;<strong>${escapeHtml(project)}</strong>&rdquo; in Mike, Quantum Group's legal document assistant.`,
      `Sign in with your usual <strong>directory (LDAP) username and password</strong> — there is no separate account to create.`,
    ],
    cta: { label: "Sign in to Mike", url },
    footNote:
      `If the button doesn't work, paste this into your browser: ${escapeHtml(url)}<br />` +
      `Don't have directory credentials? Contact your administrator.`,
  });
  return { subject, text, html, attachments: emailAttachments() };
}

/** Sent to an existing user: a short notice with a deep link to the project. */
export function addedNoticeEmail(opts: NotifyOptions): Template {
  const url = `${frontendUrl()}/projects/${opts.projectId}`;
  const project = opts.projectName;
  const subject = `You've been added to "${project}"`;
  const text =
    `${opts.inviterLabel} added you to the project "${project}" in Mike.\n\n` +
    `Open it here:\n${url}`;
  const html = renderEmail({
    heading: `You've been added to "${project}"`,
    preheader: `${opts.inviterLabel} added you to "${project}" in Mike.`,
    paragraphs: [
      `<strong>${escapeHtml(opts.inviterLabel)}</strong> added you to the project &ldquo;<strong>${escapeHtml(project)}</strong>&rdquo; in Mike. It's now available in your project list.`,
    ],
    cta: { label: "Open the project", url },
    footNote: `If the button doesn't work, paste this into your browser: ${escapeHtml(url)}`,
  });
  return { subject, text, html, attachments: emailAttachments() };
}

// Injectable dependencies — production uses the real modules; tests substitute
// fakes to assert which template each recipient receives.
export interface NotifyDeps {
  getAuthUserByEmail: typeof getAuthUserByEmail;
  ldapFindByEmail: typeof ldapFindByEmail;
  sendMail: typeof sendMail;
  smtpEnabled: typeof smtpEnabled;
}

const defaultDeps: NotifyDeps = {
  getAuthUserByEmail,
  ldapFindByEmail,
  sendMail,
  smtpEnabled,
};

async function notifyOne(
  email: string,
  opts: NotifyOptions,
  deps: NotifyDeps,
): Promise<void> {
  const existing = await deps.getAuthUserByEmail(email);
  if (existing) {
    const tpl = addedNoticeEmail(opts);
    await deps.sendMail({ to: email, ...tpl });
    return;
  }
  const directoryUser = await deps.ldapFindByEmail(email);
  if (directoryUser) {
    const tpl = invitationEmail(opts);
    await deps.sendMail({ to: email, ...tpl });
    return;
  }
  console.warn(
    `[projectInvites] ${email} was added to project ${opts.projectId} but is ` +
      `neither an app user nor in the LDAP directory; no invitation sent.`,
  );
}

/**
 * Send the appropriate notification to each newly-added collaborator. Never
 * throws — individual failures are logged and swallowed so sharing succeeds even
 * when email is down or unconfigured.
 */
export async function notifyNewCollaborators(
  opts: NotifyOptions,
  deps: NotifyDeps = defaultDeps,
): Promise<void> {
  const emails = opts.newEmails.filter((e) => e && e.includes("@"));
  if (emails.length === 0) return;
  if (!deps.smtpEnabled()) {
    console.warn(
      `[projectInvites] SMTP not configured; skipping ${emails.length} ` +
        `invitation email(s) for project ${opts.projectId}.`,
    );
    return;
  }
  const results = await Promise.allSettled(
    emails.map((email) => notifyOne(email, opts, deps)),
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(
        `[projectInvites] failed to notify ${emails[i]} for project ` +
          `${opts.projectId}:`,
        r.reason,
      );
    }
  });
}
