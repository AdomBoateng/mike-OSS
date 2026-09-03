// Integration test against the real LDAP directory. Run with
// `npm run test:integration`. Probes connectivity first (service bind); if the
// directory is unreachable from this environment or unconfigured, tests
// self-skip rather than fail.
//
// To also verify a real successful login, set LDAP_TEST_USERNAME (and
// LDAP_TEST_PASSWORD) in the environment.

import "dotenv/config";
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { Client } from "ldapts";

import { ldapAuthenticate, resolveLdapConfig } from "./ldap";

const cfg = resolveLdapConfig();
let unavailable: string | null = cfg ? null : "LDAP not configured";

describe("ldap integration (real directory)", () => {
  before(async () => {
    if (!cfg) return;
    try {
      const probe = new Client({ url: cfg.url, timeout: 5000, connectTimeout: 5000 });
      await probe.bind(cfg.searchBindDn, cfg.searchBindPassword);
      await probe.unbind();
    } catch (err) {
      unavailable = `LDAP unreachable from here: ${(err as Error).message}`;
    }
  });

  test("service bind + search: unknown user returns null", async (t: TestContext) => {
    if (unavailable) return t.skip(unavailable);
    // A null result (not a throw) proves service-bind + search both worked.
    const res = await ldapAuthenticate(`no-such-user-${Date.now()}`, "irrelevant");
    assert.equal(res, null);
  });

  test("known user + wrong password returns null", async (t: TestContext) => {
    if (unavailable) return t.skip(unavailable);
    const u = process.env.LDAP_TEST_USERNAME;
    if (!u) return t.skip("LDAP_TEST_USERNAME not set");
    const res = await ldapAuthenticate(u, `wrong-${Date.now()}`);
    assert.equal(res, null);
  });

  test("valid credentials authenticate and return identity", async (t: TestContext) => {
    if (unavailable) return t.skip(unavailable);
    const u = process.env.LDAP_TEST_USERNAME;
    const p = process.env.LDAP_TEST_PASSWORD;
    if (!u || !p) return t.skip("LDAP_TEST_USERNAME/PASSWORD not set");
    const res = await ldapAuthenticate(u, p);
    assert.ok(res, "expected successful authentication");
    assert.equal(res?.ldapUid.toLowerCase(), u.toLowerCase());
  });
});
