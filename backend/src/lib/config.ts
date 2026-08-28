// Startup configuration check.
//
// Most config in this codebase is read lazily, which is good for testability but
// means a missing secret surfaces as a 500 on the first request that needs it —
// a user hitting "sign in" is a bad place to discover SESSION_JWT_SECRET is
// unset. This module front-loads those checks so a misconfigured deployment
// fails at boot, loudly, instead of half-working.
//
// In production a problem is fatal. In development it is printed as a warning so
// a partial local setup (no S3, no SMTP) still runs.

import { resolveLdapConfig } from "./ldap";
import { resolveStorageConfig } from "./storage";
import { resolveSmtpConfig } from "./mailer";

/** Placeholder values shipped in .env.example; never valid in production. */
const PLACEHOLDERS = [
  "replace-with-a-random-32-byte-hex-string",
  "your-long-random-secret",
  "changeme",
];

const MIN_SECRET_LENGTH = 32;

export interface ConfigProblem {
  /** `true` blocks startup in production; `false` only degrades a feature. */
  fatal: boolean;
  message: string;
}

function checkSecret(name: string, problems: ConfigProblem[]): void {
  const value = process.env[name]?.trim();
  if (!value) {
    problems.push({ fatal: true, message: `${name} is not set.` });
    return;
  }
  if (PLACEHOLDERS.includes(value.toLowerCase())) {
    problems.push({
      fatal: true,
      message: `${name} still holds its .env.example placeholder. Generate one with: openssl rand -hex 32`,
    });
    return;
  }
  if (value.length < MIN_SECRET_LENGTH) {
    problems.push({
      fatal: true,
      message: `${name} is only ${value.length} characters; use at least ${MIN_SECRET_LENGTH} (openssl rand -hex 32).`,
    });
  }
}

/**
 * Inspect the environment and return everything that looks wrong. Pure — it
 * reads env and resolves config but has no side effects, so it is directly
 * testable.
 */
export function findConfigProblems(
  env: NodeJS.ProcessEnv = process.env,
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const isProduction = env.NODE_ENV === "production";

  // Secrets. Without these the corresponding feature cannot work at all.
  checkSecret("SESSION_JWT_SECRET", problems);
  checkSecret("DOWNLOAD_SIGNING_SECRET", problems);
  checkSecret("USER_API_KEYS_ENCRYPTION_SECRET", problems);

  // Distinct secrets: reusing one key across signing and encryption means a
  // single leak compromises sessions, download links and stored API keys alike.
  const secrets = [
    env.SESSION_JWT_SECRET,
    env.DOWNLOAD_SIGNING_SECRET,
    env.USER_API_KEYS_ENCRYPTION_SECRET,
  ].filter((s): s is string => !!s?.trim());
  if (new Set(secrets).size !== secrets.length) {
    problems.push({
      fatal: true,
      message:
        "SESSION_JWT_SECRET, DOWNLOAD_SIGNING_SECRET and USER_API_KEYS_ENCRYPTION_SECRET must each be a different value.",
    });
  }

  if (!env.DATABASE_URL?.trim()) {
    problems.push({ fatal: true, message: "DATABASE_URL is not set." });
  }

  // External services. Each one disables a feature rather than the whole app,
  // but in production all of them are expected to be present.
  if (!resolveLdapConfig()) {
    problems.push({
      fatal: true,
      message:
        "LDAP is not configured (LDAP_URL, LDAP_SEARCH_BIND_DN, LDAP_SEARCH_BIND_PASSWORD, LDAP_USER_BASE_DN). Nobody can sign in.",
    });
  }

  if (!resolveStorageConfig()) {
    problems.push({
      fatal: isProduction,
      message:
        "S3 storage is not configured (S3_ENDPOINT_URL, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY). Document upload and download will fail.",
    });
  }

  if (!env.CUSTOM_LLM_BASE_URL?.trim()) {
    problems.push({
      fatal: isProduction,
      message:
        "CUSTOM_LLM_BASE_URL is not set. The model picker will be empty and the assistant cannot answer.",
    });
  }

  if (!resolveSmtpConfig()) {
    problems.push({
      fatal: false,
      message:
        "SMTP is not configured (SMTP_HOST, SMTP_FROM). Collaborator invitation emails will be skipped.",
    });
  }

  // Production-only hardening.
  if (isProduction) {
    const origins = (env.FRONTEND_URL ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);

    if (origins.includes("*")) {
      problems.push({
        fatal: false,
        message:
          'FRONTEND_URL is "*", so any website can call this API with a stolen token. Set it to the exact origin(s) for an internet-facing deployment.',
      });
    }

    // This dumps raw model traffic — which includes the text of the legal
    // documents under discussion — to unencrypted files on disk.
    if (env.RAW_LLM_STREAM_LOG_DIR?.trim()) {
      problems.push({
        fatal: false,
        message:
          "RAW_LLM_STREAM_LOG_DIR is set: full model streams, including document text, are being written to disk. Unset it unless you are actively debugging.",
      });
    }

    // Emails link to APP_PUBLIC_URL; without it they fall back to the first
    // FRONTEND_URL origin, and to localhost when that is "*" — a dead link.
    const emailBase =
      env.APP_PUBLIC_URL?.trim() ||
      origins.find((o) => o !== "*" && /^https?:\/\//i.test(o));
    if (!emailBase && resolveSmtpConfig()) {
      problems.push({
        fatal: false,
        message:
          "APP_PUBLIC_URL is not set and FRONTEND_URL has no usable origin, so invitation emails would link to http://localhost:3000.",
      });
    }
  }

  return problems;
}

/**
 * Run the check at startup. Logs every problem; in production, throws if any is
 * fatal so the process exits instead of serving a broken deployment.
 */
export function assertConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = findConfigProblems(env);
  if (problems.length === 0) {
    console.log("[config] environment looks complete.");
    return;
  }

  const isProduction = env.NODE_ENV === "production";
  const fatal = problems.filter((p) => p.fatal);
  const warnings = problems.filter((p) => !p.fatal);

  for (const p of warnings) console.warn(`[config] warning: ${p.message}`);
  for (const p of fatal) {
    if (isProduction) console.error(`[config] ERROR: ${p.message}`);
    else console.warn(`[config] warning: ${p.message}`);
  }

  if (isProduction && fatal.length > 0) {
    throw new Error(
      `Refusing to start: ${fatal.length} fatal configuration problem(s). ` +
        `See the [config] ERROR lines above, and backend/.env.example.`,
    );
  }
  if (!isProduction && fatal.length > 0) {
    console.warn(
      `[config] ${fatal.length} problem(s) above would stop startup with NODE_ENV=production.`,
    );
  }
}
