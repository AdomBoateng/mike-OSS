// Integration tests for the Postgres query-builder shim against a REAL Postgres
// (docker-compose.yml). Kept out of the default `npm test`; run with:
//
//   npm run test:integration
//
// Loads .env; self-skips when DATABASE_URL is not set. Uses a throwaway table so
// it never touches application data.

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { createDb } from "./index";
import { query, closePool } from "./pool";

const enabled = !!process.env.DATABASE_URL;
const skip = enabled ? false : "DATABASE_URL not set — skipping db integration";

const db = createDb();
const T = "__db_shim_it";

describe("db shim integration (real Postgres)", { skip }, () => {
  before(async () => {
    await query(`drop table if exists ${T}`, []);
    await query(
      `create table ${T} (
         id uuid primary key default gen_random_uuid(),
         name text,
         score int,
         tags jsonb,
         created_at timestamptz not null default now()
       )`,
      [],
    );
  });

  after(async () => {
    await query(`drop table if exists ${T}`, []);
    await closePool();
  });

  test("insert + select round-trip with jsonb", async () => {
    const ins = await db
      .from(T)
      .insert({ name: "alpha", score: 10, tags: ["x", "y"] })
      .select()
      .single();
    assert.equal(ins.error, null);
    const row = ins.data as { id: string; name: string; tags: string[] };
    assert.equal(row.name, "alpha");
    assert.deepEqual(row.tags, ["x", "y"]); // jsonb decoded back to a JS array

    const got = await db.from(T).select("*").eq("id", row.id).single();
    assert.equal(got.error, null);
    assert.equal((got.data as { score: number }).score, 10);
  });

  test("filters: eq, in, is null, gt", async () => {
    await db.from(T).insert([
      { name: "beta", score: 5 },
      { name: "gamma", score: 20 },
      { name: null, score: 0 },
    ]);

    const inRes = await db.from(T).select("name").in("name", ["beta", "gamma"]);
    const names = (inRes.data as { name: string }[]).map((r) => r.name).sort();
    assert.deepEqual(names, ["beta", "gamma"]);

    const nulls = await db.from(T).select("*").is("name", null);
    assert.equal((nulls.data as unknown[]).length, 1);

    const high = await db.from(T).select("name").gt("score", 9).order("score", { ascending: true });
    const highNames = (high.data as { name: string }[]).map((r) => r.name);
    assert.deepEqual(highNames, ["alpha", "gamma"]);
  });

  test("update with returning", async () => {
    const upd = await db
      .from(T)
      .update({ score: 99 })
      .eq("name", "beta")
      .select()
      .single();
    assert.equal(upd.error, null);
    assert.equal((upd.data as { score: number }).score, 99);
  });

  test("maybeSingle returns null for no match", async () => {
    const res = await db.from(T).select("*").eq("name", "does-not-exist").maybeSingle();
    assert.equal(res.error, null);
    assert.equal(res.data, null);
  });

  test("head count", async () => {
    const res = await db.from(T).select("id", { count: "exact", head: true });
    assert.equal(res.data, null);
    assert.ok((res.count ?? 0) >= 4);
  });

  test("delete removes rows", async () => {
    await db.from(T).delete().eq("name", "gamma");
    const gone = await db.from(T).select("*").eq("name", "gamma");
    assert.equal((gone.data as unknown[]).length, 0);
  });

  test("db error is returned, not thrown (unknown column)", async () => {
    const res = await db.from(T).select("*").eq("no_such_col", 1);
    assert.equal(res.data, null);
    assert.ok(res.error);
    assert.equal(res.error?.code, "42703"); // undefined_column
  });

  test("rpc calls a RETURNS TABLE function", async () => {
    // get_workflows_overview(p_user_id uuid, p_user_email text) RETURNS TABLE.
    // A random user simply yields zero rows — this exercises the rpc plumbing.
    const res = await db.rpc("get_workflows_overview", {
      p_user_id: "00000000-0000-0000-0000-000000000000",
      p_user_email: "nobody@example.com",
    });
    assert.equal(res.error, null);
    assert.ok(Array.isArray(res.data));
  });
});
