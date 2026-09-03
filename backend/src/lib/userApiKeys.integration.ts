// End-to-end proof that real application data-access code runs against the
// self-hosted Postgres through the query shim (createServerSupabase now returns
// it). Exercises userApiKeys.ts — encrypted upsert, status select, decrypt —
// against a real seeded user. Run with `npm run test:integration`; self-skips
// without DATABASE_URL.

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { query, closePool } from "./db";
import {
  getUserApiKeyStatus,
  getUserApiKeys,
  saveUserApiKey,
} from "./userApiKeys";

const enabled = !!process.env.DATABASE_URL && !!process.env.USER_API_KEYS_ENCRYPTION_SECRET;
const skip = enabled
  ? false
  : "DATABASE_URL / USER_API_KEYS_ENCRYPTION_SECRET not set — skipping";

let userId: string;

describe("userApiKeys via query shim (real Postgres)", { skip }, () => {
  before(async () => {
    const res = await query(
      `insert into auth.users (email) values ($1) returning id`,
      ["apikeys-it@example.com"],
    );
    userId = (res.rows[0] as { id: string }).id;
  });

  after(async () => {
    await query(`delete from auth.users where id = $1`, [userId]);
    await closePool();
  });

  test("save -> status -> decrypt round-trip (real upsert/select)", async () => {
    await saveUserApiKey(userId, "claude", "sk-test-abc123");

    const status = await getUserApiKeyStatus(userId);
    assert.equal(status.claude, true);
    assert.equal(status.sources.claude, "user");

    const keys = await getUserApiKeys(userId);
    assert.equal(keys.claude, "sk-test-abc123"); // decrypted back out
  });

  test("upsert overwrites the stored key", async () => {
    await saveUserApiKey(userId, "claude", "sk-test-updated");
    const keys = await getUserApiKeys(userId);
    assert.equal(keys.claude, "sk-test-updated");
  });

  test("saving null deletes the key", async () => {
    await saveUserApiKey(userId, "claude", null);
    const status = await getUserApiKeyStatus(userId);
    // No env ANTHROPIC/CLAUDE key in this env, so it reads as unconfigured.
    assert.equal(status.claude, false);
  });
});
