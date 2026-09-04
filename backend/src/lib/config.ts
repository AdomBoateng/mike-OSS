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

import { probeLdap, resolveLdapConfig } from "./ldap";
import { probeStorage, resolveStorageConfig } from "./storage";
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

    const invalidOrigins = origins.filter((origin) => {
      try {
        const parsed = new URL(origin);
        return parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol);
      } catch {
        return true;
      }
    });
    if (origins.length === 0 || origins.includes("*") || invalidOrigins.length > 0) {
      problems.push({
        fatal: true,
        message:
          "FRONTEND_URL must contain exact HTTP(S) origins in production; wildcard, missing, malformed, or path-bearing values are unsafe with cookie authentication.",
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

// ---------------------------------------------------------------------------
// Storage reachability
// ---------------------------------------------------------------------------
//
// findConfigProblems() above is deliberately pure: it proves the env vars are
// set, nothing more. That is not enough for storage. A deployment on a network
// with no route to the storage subnet passes every check here, boots happily,
// and then fails on someone's first upload. The probe below closes that gap by
// actually talking to the endpoint before the port is bound.

export type StorageProbeMode = "fatal" | "warn" | "off";

/**
 * How hard a failed probe should bite. Defaults to fatal in production and a
 * warning elsewhere, matching how the rest of this module treats missing
 * infrastructure. The override exists for an air-gapped or partial deployment:
 * "off" skips the probe, "warn" boots anyway so it can be fixed live.
 */
function probeMode(varName: string, env: NodeJS.ProcessEnv): StorageProbeMode {
  const raw = env[varName]?.trim().toLowerCase();
  if (raw === "off" || raw === "false") return "off";
  if (raw === "warn") return "warn";
  if (raw === "fatal") return "fatal";
  return env.NODE_ENV === "production" ? "fatal" : "warn";
}

export function storageProbeMode(
  env: NodeJS.ProcessEnv = process.env,
): StorageProbeMode {
  return probeMode("STORAGE_STARTUP_PROBE", env);
}

export function ldapProbeMode(
  env: NodeJS.ProcessEnv = process.env,
): StorageProbeMode {
  return probeMode("LDAP_STARTUP_PROBE", env);
}

/** Attempts made before giving up, and the pause between them. */
const PROBE_ATTEMPTS = 3;
const PROBE_RETRY_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Probe storage, retrying a few times.
 *
 * The retries are the point: a container often starts a second or two before
 * the network around it is ready, and killing production over a blip that would
 * have cleared on its own is worse than the problem being detected. A genuine
 * misroute fails all three attempts and is still caught.
 *
 * Returns null when storage is reachable or the probe is disabled.
 */
export async function checkStorageReachable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigProblem | null> {
  const mode = storageProbeMode(env);
  if (mode === "off") return null;

  // Nothing to probe; findConfigProblems() already reports it as unconfigured
  // and would only be duplicated here.
  if (!resolveStorageConfig()) return null;

  let last = await probeStorage();
  for (let attempt = 2; attempt <= PROBE_ATTEMPTS && !last.ok; attempt++) {
    // Only a network fault is worth retrying. A rejected key or a missing
    // bucket will answer identically every time.
    if (last.kind !== "unreachable") break;
    console.warn(
      `[config] storage probe attempt ${attempt - 1}/${PROBE_ATTEMPTS} failed; retrying in ${
        PROBE_RETRY_DELAY_MS / 1000
      }s...`,
    );
    await sleep(PROBE_RETRY_DELAY_MS);
    last = await probeStorage();
  }

  if (last.ok) {
    console.log(
      `[config] storage reachable: bucket "${last.bucket}" at ${last.endpoint} (${last.ms}ms).`,
    );
    return null;
  }

  const fatal = mode === "fatal";
  if (last.kind === "unreachable") {
    return {
      fatal,
      message:
        `S3 storage at ${last.endpoint} is unreachable after ${PROBE_ATTEMPTS} attempts — ${last.detail}. ` +
        "The credentials may be perfectly good; this looks like a routing or firewall problem between this host " +
        "and the storage network. Document upload and download would fail for every user. " +
        "Set STORAGE_STARTUP_PROBE=warn to start anyway.",
    };
  }
  return {
    fatal,
    message:
      `S3 storage at ${last.endpoint} answered, but the check failed — ${last.detail} ` +
      "Set STORAGE_STARTUP_PROBE=warn to start anyway.",
  };
}

/**
 * Probe the directory, retrying network faults the same way storage does.
 *
 * Returns null when LDAP is reachable or the probe is disabled.
 */
export async function checkLdapReachable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigProblem | null> {
  const mode = ldapProbeMode(env);
  if (mode === "off") return null;
  if (!resolveLdapConfig()) return null; // already reported by findConfigProblems

  let last = await probeLdap();
  for (let attempt = 2; attempt <= PROBE_ATTEMPTS && !last.ok; attempt++) {
    if (last.kind !== "unreachable") break;
    console.warn(
      `[config] LDAP probe attempt ${attempt - 1}/${PROBE_ATTEMPTS} failed; retrying in ${
        PROBE_RETRY_DELAY_MS / 1000
      }s...`,
    );
    await sleep(PROBE_RETRY_DELAY_MS);
    last = await probeLdap();
  }

  if (last.ok) {
    console.log(`[config] LDAP reachable: ${last.url} (${last.ms}ms).`);
    return null;
  }

  const fatal = mode === "fatal";
  if (last.kind === "unreachable") {
    return {
      fatal,
      message:
        `LDAP at ${last.url} is unreachable after ${PROBE_ATTEMPTS} attempts — ${last.detail}. ` +
        "Nobody would be able to sign in. This is a routing or firewall problem rather than a credentials one. " +
        "If this host runs Docker, check that no bridge network overlaps the directory's subnet " +
        "(docker network ls, then inspect each subnet). Set LDAP_STARTUP_PROBE=warn to start anyway.",
    };
  }
  return {
    fatal,
    message:
      `LDAP at ${last.url} answered, but the check failed — ${last.detail} ` +
      "Set LDAP_STARTUP_PROBE=warn to start anyway.",
  };
}

/**
 * Startup gate for the external services the app cannot work without.
 *
 * Both probes run concurrently and every failure is reported before throwing:
 * fixing one firewall rule only to rediscover the next on the following boot is
 * exactly the loop this is meant to end.
 */
export async function assertDependenciesReachable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const problems = (
    await Promise.all([checkStorageReachable(env), checkLdapReachable(env)])
  ).filter((p): p is ConfigProblem => p !== null);
  if (problems.length === 0) return;

  const fatal = problems.filter((p) => p.fatal);
  for (const p of problems.filter((p) => !p.fatal)) {
    console.warn(`[config] warning: ${p.message}`);
  }
  for (const p of fatal) console.error(`[config] ERROR: ${p.message}`);

  if (fatal.length > 0) {
    throw new Error(
      `Refusing to start: ${fatal.length} unreachable ${
        fatal.length === 1 ? "dependency" : "dependencies"
      }. See the [config] ERROR lines above.`,
    );
  }
}

/** Storage-only gate, kept for callers that need just this one check. */
export async function assertStorageReachable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const problem = await checkStorageReachable(env);
  if (!problem) return;

  if (problem.fatal) {
    console.error(`[config] ERROR: ${problem.message}`);
    throw new Error(`Refusing to start: ${problem.message}`);
  }
  console.warn(`[config] warning: ${problem.message}`);
}
