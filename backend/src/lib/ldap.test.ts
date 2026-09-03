import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { resolveLdapConfig, ldapEnabled, escapeFilterValue } from "./ldap";

const LDAP_ENV = [
  "LDAP_URL",
  "LDAP_SEARCH_BIND_DN",
  "LDAP_SEARCH_BIND_PASSWORD",
  "LDAP_USER_BASE_DN",
  "LDAP_USERNAME_ATTRIBUTE",
  "LDAP_MAIL_ATTRIBUTE",
  "LDAP_OPERATION_TIMEOUT_MS",
] as const;

describe("resolveLdapConfig", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of LDAP_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of LDAP_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("returns null when unconfigured", () => {
    assert.equal(resolveLdapConfig(), null);
    assert.equal(ldapEnabled(), false);
  });

  test("returns null when a required field is missing", () => {
    process.env.LDAP_URL = "ldap://host:389";
    process.env.LDAP_SEARCH_BIND_DN = "uid=svc,dc=x";
    // password + base DN missing
    assert.equal(resolveLdapConfig(), null);
  });

  test("reads config with sensible defaults", () => {
    process.env.LDAP_URL = "ldap://host:389";
    process.env.LDAP_SEARCH_BIND_DN = "uid=svc,dc=x";
    process.env.LDAP_SEARCH_BIND_PASSWORD = "pw";
    process.env.LDAP_USER_BASE_DN = "cn=users,dc=x";
    const cfg = resolveLdapConfig();
    assert.equal(cfg?.usernameAttribute, "uid");
    assert.equal(cfg?.mailAttribute, "mail");
    assert.equal(cfg?.timeoutMs, 10000);
    assert.equal(ldapEnabled(), true);
  });

  test("honors attribute and timeout overrides", () => {
    process.env.LDAP_URL = "ldap://host:389";
    process.env.LDAP_SEARCH_BIND_DN = "uid=svc,dc=x";
    process.env.LDAP_SEARCH_BIND_PASSWORD = "pw";
    process.env.LDAP_USER_BASE_DN = "cn=users,dc=x";
    process.env.LDAP_USERNAME_ATTRIBUTE = "sAMAccountName";
    process.env.LDAP_OPERATION_TIMEOUT_MS = "5000";
    const cfg = resolveLdapConfig();
    assert.equal(cfg?.usernameAttribute, "sAMAccountName");
    assert.equal(cfg?.timeoutMs, 5000);
  });
});

describe("escapeFilterValue", () => {
  test("escapes LDAP filter metacharacters (RFC 4515)", () => {
    assert.equal(escapeFilterValue("normal"), "normal");
    assert.equal(escapeFilterValue("a*b"), "a\\2ab");
    assert.equal(escapeFilterValue("a(b)c"), "a\\28b\\29c");
    assert.equal(escapeFilterValue("a\\b"), "a\\5cb");
    assert.equal(escapeFilterValue("x*)(uid=*"), "x\\2a\\29\\28uid=\\2a");
  });
});
