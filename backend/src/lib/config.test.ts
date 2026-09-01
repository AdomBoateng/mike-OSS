import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  findConfigProblems,
  assertConfig,
  storageProbeMode,
  ldapProbeMode,
  checkStorageReachable,
  checkLdapReachable,
} from "./config";

// findConfigProblems takes an env argument, but the resolve*Config() helpers it
// calls read process.env directly — so tests swap process.env wholesale and pass
// the same object in.
const REAL_ENV = process.env;

/** A complete, valid production environment. */
function goodEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    SESSION_JWT_SECRET: "a".repeat(64),
    DOWNLOAD_SIGNING_SECRET: "b".repeat(64),
    USER_API_KEYS_ENCRYPTION_SECRET: "c".repeat(64),
    DATABASE_URL: "postgres://mike:pw@postgres:5432/mike",
    LDAP_URL: "ldap://ldap.internal:389",
    LDAP_SEARCH_BIND_DN: "uid=svc,cn=users,dc=example,dc=com",
    LDAP_SEARCH_BIND_PASSWORD: "svc-password",
    LDAP_USER_BASE_DN: "cn=users,dc=example,dc=com",
    S3_ENDPOINT_URL: "https://s3.internal",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
    S3_BUCKET_NAME: "mike",
    CUSTOM_LLM_BASE_URL: "http://vllm.internal:8000/v1",
    SMTP_HOST: "mail.internal",
    SMTP_FROM: "Mike <no-reply@internal>",
    FRONTEND_URL: "https://mike.example.com",
    APP_PUBLIC_URL: "https://mike.example.com",
  };
}

function withEnv(env: NodeJS.ProcessEnv) {
  process.env = env;
  return findConfigProblems(env);
}

const messages = (problems: { message: string }[]) =>
  problems.map((p) => p.message).join("\n");

afterEach(() => {
  process.env = REAL_ENV;
});

describe("findConfigProblems", () => {
  test("a complete production environment has no problems", () => {
    assert.deepEqual(withEnv(goodEnv()), []);
  });

  test("missing secrets are fatal", () => {
    const env = goodEnv();
    delete env.SESSION_JWT_SECRET;
    const problems = withEnv(env);
    assert.match(messages(problems), /SESSION_JWT_SECRET is not set/);
    assert.ok(problems.every((p) => !p.message.includes("SESSION") || p.fatal));
  });

  test("a .env.example placeholder secret is rejected", () => {
    const env = goodEnv();
    env.DOWNLOAD_SIGNING_SECRET = "replace-with-a-random-32-byte-hex-string";
    const problems = withEnv(env);
    assert.match(messages(problems), /DOWNLOAD_SIGNING_SECRET still holds/);
    assert.ok(problems.some((p) => p.fatal));
  });

  test("a too-short secret is rejected", () => {
    const env = goodEnv();
    env.SESSION_JWT_SECRET = "short";
    assert.match(messages(withEnv(env)), /only 5 characters/);
  });

  test("reusing one value across the three secrets is rejected", () => {
    const env = goodEnv();
    env.DOWNLOAD_SIGNING_SECRET = env.SESSION_JWT_SECRET;
    assert.match(messages(withEnv(env)), /must each be a different value/);
  });

  test("unconfigured LDAP is fatal — nobody could sign in", () => {
    const env = goodEnv();
    delete env.LDAP_URL;
    const problems = withEnv(env);
    const ldap = problems.find((p) => p.message.includes("LDAP"));
    assert.ok(ldap?.fatal);
  });

  test("missing storage and model endpoint are fatal in production only", () => {
    const prod = goodEnv();
    delete prod.S3_ENDPOINT_URL;
    delete prod.CUSTOM_LLM_BASE_URL;
    assert.ok(
      withEnv(prod)
        .filter(
          (p) =>
            p.message.includes("S3 storage") ||
            p.message.includes("CUSTOM_LLM_BASE_URL"),
        )
        .every((p) => p.fatal),
    );

    const dev = goodEnv();
    dev.NODE_ENV = "development";
    delete dev.S3_ENDPOINT_URL;
    delete dev.CUSTOM_LLM_BASE_URL;
    assert.ok(
      withEnv(dev)
        .filter(
          (p) =>
            p.message.includes("S3 storage") ||
            p.message.includes("CUSTOM_LLM_BASE_URL"),
        )
        .every((p) => !p.fatal),
    );
  });

  test("missing SMTP only warns — sharing still works without email", () => {
    const env = goodEnv();
    delete env.SMTP_HOST;
    delete env.SMTP_FROM;
    const smtp = withEnv(env).find((p) => p.message.includes("SMTP"));
    assert.ok(smtp);
    assert.equal(smtp.fatal, false);
  });

  test('a wildcard FRONTEND_URL warns in production', () => {
    const env = goodEnv();
    env.FRONTEND_URL = "*";
    const problems = withEnv(env);
    const cors = problems.find((p) => p.message.includes("FRONTEND_URL"));
    assert.ok(cors);
    assert.equal(cors.fatal, false);
  });

  test("wildcard CORS is not flagged outside production", () => {
    const env = goodEnv();
    env.NODE_ENV = "development";
    env.FRONTEND_URL = "*";
    assert.ok(!messages(withEnv(env)).includes('FRONTEND_URL is "*"'));
  });

  test("email-capable production without a public URL warns", () => {
    const env = goodEnv();
    delete env.APP_PUBLIC_URL;
    env.FRONTEND_URL = "*";
    assert.match(messages(withEnv(env)), /APP_PUBLIC_URL is not set/);
  });

  test("raw LLM stream logging warns in production", () => {
    const env = goodEnv();
    env.RAW_LLM_STREAM_LOG_DIR = "/tmp/streams";
    const problem = withEnv(env).find((p) =>
      p.message.includes("RAW_LLM_STREAM_LOG_DIR"),
    );
    assert.ok(problem);
    assert.equal(problem.fatal, false);
  });

  test("no email warning when APP_PUBLIC_URL is absent but SMTP is too", () => {
    const env = goodEnv();
    delete env.APP_PUBLIC_URL;
    delete env.SMTP_HOST;
    delete env.SMTP_FROM;
    env.FRONTEND_URL = "*";
    assert.ok(!messages(withEnv(env)).includes("APP_PUBLIC_URL is not set"));
  });
});

describe("assertConfig", () => {
  let logs: string[];
  const realLog = console.log;
  const realWarn = console.warn;
  const realError = console.error;

  beforeEach(() => {
    logs = [];
    const capture = (...a: unknown[]) => void logs.push(a.join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
  });

  afterEach(() => {
    console.log = realLog;
    console.warn = realWarn;
    console.error = realError;
    process.env = REAL_ENV;
  });

  test("throws in production when something fatal is missing", () => {
    const env = goodEnv();
    delete env.SESSION_JWT_SECRET;
    process.env = env;
    assert.throws(() => assertConfig(env), /Refusing to start/);
  });

  test("does not throw in development for the same environment", () => {
    const env = goodEnv();
    env.NODE_ENV = "development";
    delete env.SESSION_JWT_SECRET;
    process.env = env;
    assert.doesNotThrow(() => assertConfig(env));
    assert.match(logs.join("\n"), /would stop startup with NODE_ENV=production/);
  });

  test("does not throw in production for warnings alone", () => {
    const env = goodEnv();
    delete env.SMTP_HOST;
    delete env.SMTP_FROM;
    process.env = env;
    assert.doesNotThrow(() => assertConfig(env));
  });

  test("a complete environment is reported as clean", () => {
    const env = goodEnv();
    process.env = env;
    assertConfig(env);
    assert.match(logs.join("\n"), /environment looks complete/);
  });
});

describe("storageProbeMode", () => {
  test("defaults to fatal in production and a warning elsewhere", () => {
    assert.equal(storageProbeMode({ NODE_ENV: "production" }), "fatal");
    assert.equal(storageProbeMode({ NODE_ENV: "development" }), "warn");
    assert.equal(storageProbeMode({}), "warn");
  });

  test("an explicit setting overrides the default in both directions", () => {
    // "off" has to work in production: an air-gapped or storage-less
    // deployment must still be able to boot deliberately.
    assert.equal(
      storageProbeMode({ NODE_ENV: "production", STORAGE_STARTUP_PROBE: "off" }),
      "off",
    );
    assert.equal(
      storageProbeMode({ NODE_ENV: "production", STORAGE_STARTUP_PROBE: "warn" }),
      "warn",
    );
    assert.equal(
      storageProbeMode({ NODE_ENV: "development", STORAGE_STARTUP_PROBE: "fatal" }),
      "fatal",
    );
  });

  test("an unrecognised value falls back to the default rather than disabling the check", () => {
    // Silently treating a typo as "off" would quietly remove the guard in
    // production, which is the one place it matters.
    assert.equal(
      storageProbeMode({ NODE_ENV: "production", STORAGE_STARTUP_PROBE: "yes-please" }),
      "fatal",
    );
  });
});

describe("checkStorageReachable", () => {
  test("is skipped entirely when the probe is off", async () => {
    const env = { ...goodEnv(), STORAGE_STARTUP_PROBE: "off" };
    process.env = env;
    // No network call, so this returns immediately even though the endpoint
    // in goodEnv() does not exist.
    assert.equal(await checkStorageReachable(env), null);
  });

  test("unconfigured storage is not reported twice", async () => {
    // findConfigProblems already flags this; repeating it here would give the
    // operator two different messages for one missing setting.
    const env = { ...goodEnv() };
    delete env.S3_ENDPOINT_URL;
    delete env.S3_ACCESS_KEY_ID;
    delete env.S3_SECRET_ACCESS_KEY;
    process.env = env;
    assert.equal(await checkStorageReachable(env), null);
  });
});

describe("ldapProbeMode", () => {
  test("follows the same fatal-in-production default as storage", () => {
    assert.equal(ldapProbeMode({ NODE_ENV: "production" }), "fatal");
    assert.equal(ldapProbeMode({}), "warn");
  });

  test("is controlled independently of the storage probe", () => {
    // Turning off one probe must not silently disable the other; they guard
    // different failures and get fixed at different times.
    const env = {
      NODE_ENV: "production",
      STORAGE_STARTUP_PROBE: "off",
      LDAP_STARTUP_PROBE: "fatal",
    };
    assert.equal(storageProbeMode(env), "off");
    assert.equal(ldapProbeMode(env), "fatal");
  });
});

describe("checkLdapReachable", () => {
  test("is skipped entirely when the probe is off", async () => {
    const env = { ...goodEnv(), LDAP_STARTUP_PROBE: "off" };
    process.env = env;
    assert.equal(await checkLdapReachable(env), null);
  });

  test("unconfigured LDAP is not reported twice", async () => {
    const env = { ...goodEnv() };
    delete env.LDAP_URL;
    delete env.LDAP_SEARCH_BIND_DN;
    delete env.LDAP_SEARCH_BIND_PASSWORD;
    delete env.LDAP_USER_BASE_DN;
    process.env = env;
    assert.equal(await checkLdapReachable(env), null);
  });
});
