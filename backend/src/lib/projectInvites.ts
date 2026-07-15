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

export interface NotifyOptions {
  projectId: string;
  projectName: string;
  /** Human label for who did the sharing (display name or email). */
  inviterLabel: string;
  /** Newly-added collaborator emails (already normalised/lowercased). */
  newEmails: string[];
}

function frontendUrl(): string {
  return (process.env.FRONTEND_URL?.trim() || "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface Template {
  subject: string;
  text: string;
  html: string;
}

export function invitationEmail(opts: NotifyOptions): Template {
  const url = frontendUrl();
  const project = opts.projectName;
  const subject = `${opts.inviterLabel} invited you to collaborate on "${project}"`;
  const text =
    `${opts.inviterLabel} has invited you to collaborate on the project "${project}" in Mike.\n\n` +
    `Sign in with your LDAP (directory) credentials to access it:\n${url}\n\n` +
    `If you do not have LDAP credentials, contact your administrator.`;
  const html =
    `<p>${escapeHtml(opts.inviterLabel)} has invited you to collaborate on the project ` +
    `"<strong>${escapeHtml(project)}</strong>" in Mike.</p>` +
    `<p>Sign in with your <strong>LDAP (directory) credentials</strong> to access it:</p>` +
    `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` +
    `<p>If you do not have LDAP credentials, contact your administrator.</p>`;
  return { subject, text, html };
}

export function addedNoticeEmail(opts: NotifyOptions): Template {
  const url = `${frontendUrl()}/projects/${opts.projectId}`;
  const project = opts.projectName;
  const subject = `You've been added to "${project}"`;
  const text =
    `${opts.inviterLabel} added you to the project "${project}" in Mike.\n\n` +
    `Open it here:\n${url}`;
  const html =
    `<p>${escapeHtml(opts.inviterLabel)} added you to the project ` +
    `"<strong>${escapeHtml(project)}</strong>" in Mike.</p>` +
    `<p><a href="${escapeHtml(url)}">Open the project</a></p>`;
  return { subject, text, html };
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
