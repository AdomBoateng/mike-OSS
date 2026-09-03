import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { resolveSmtpConfig, smtpEnabled } from "./mailer";

const SMTP_ENV_VARS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
] as const;

describe("resolveSmtpConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of SMTP_ENV_VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SMTP_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("returns null when host and from are missing", () => {
    assert.equal(resolveSmtpConfig(), null);
    assert.equal(smtpEnabled(), false);
  });

  test("returns null when only host is set (no from)", () => {
    process.env.SMTP_HOST = "mail.example.com";
    assert.equal(resolveSmtpConfig(), null);
  });

  test("returns null when only from is set (no host)", () => {
    process.env.SMTP_FROM = "Mike <no-reply@example.com>";
    assert.equal(resolveSmtpConfig(), null);
  });

  test("resolves with defaults when host and from are present", () => {
    process.env.SMTP_HOST = "mail.example.com";
    process.env.SMTP_FROM = "Mike <no-reply@example.com>";
    const cfg = resolveSmtpConfig();
    assert.ok(cfg);
    assert.equal(cfg.host, "mail.example.com");
    assert.equal(cfg.port, 587); // default
    assert.equal(cfg.secure, false); // default
    assert.equal(cfg.user, undefined);
    assert.equal(cfg.pass, undefined);
    assert.equal(cfg.from, "Mike <no-reply@example.com>");
    assert.equal(smtpEnabled(), true);
  });

  test("honours explicit port, secure flag and credentials", () => {
    process.env.SMTP_HOST = "mail.example.com";
    process.env.SMTP_FROM = "Mike <no-reply@example.com>";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "TRUE"; // case-insensitive
    process.env.SMTP_USER = "svc";
    process.env.SMTP_PASS = "secret";
    const cfg = resolveSmtpConfig();
    assert.ok(cfg);
    assert.equal(cfg.port, 465);
    assert.equal(cfg.secure, true);
    assert.equal(cfg.user, "svc");
    assert.equal(cfg.pass, "secret");
  });

  test("treats whitespace-only host as unset", () => {
    process.env.SMTP_HOST = "   ";
    process.env.SMTP_FROM = "Mike <no-reply@example.com>";
    assert.equal(resolveSmtpConfig(), null);
  });
});
