// Verifies LDAP identity seeding against the real Postgres: upsertLdapUser
// creates an auth.users row (firing handle_new_user() to seed user_profiles),
// reuses the same app UUID on repeat logins, and updates email. Run with
// `npm run test:integration`; self-skips without DATABASE_URL.

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { query, closePool } from "./db";
import { upsertLdapUser, getAuthUserById } from "./authUsers";

const enabled = !!process.env.DATABASE_URL;
const skip = enabled ? false : "DATABASE_URL not set — skipping";

const LDAP_UID = `it-ldap-${Date.now()}`;

describe("LDAP identity seeding (real Postgres)", { skip }, () => {
  after(async () => {
    await query(`delete from auth.users where ldap_uid = $1`, [LDAP_UID]);
    await closePool();
  });

  test("first login creates the user and seeds a profile via trigger", async () => {
    const user = await upsertLdapUser(LDAP_UID, "it@example.com");
    assert.ok(user.id);
    assert.equal(user.ldapUid, LDAP_UID);

    const profiles = await query(
      `select 1 from public.user_profiles where user_id = $1`,
      [user.id],
    );
    assert.equal(profiles.rows.length, 1); // trigger seeded the profile
  });

  test("repeat login reuses the same app UUID and updates email", async () => {
    const first = await upsertLdapUser(LDAP_UID, "it@example.com");
    const second = await upsertLdapUser(LDAP_UID, "it-new@example.com");
    assert.equal(second.id, first.id); // stable identity
    assert.equal(second.email, "it-new@example.com");

    const fetched = await getAuthUserById(first.id);
    assert.equal(fetched?.email, "it-new@example.com");
  });
});
