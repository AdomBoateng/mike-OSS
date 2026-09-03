import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { QueryBuilder, type QueryExecutor } from "./queryBuilder";

const noop: QueryExecutor = async () => ({ rows: [], rowCount: 0 });
const qb = (table: string) => new QueryBuilder(table, noop);

describe("QueryBuilder SQL generation", () => {
  test("select all", () => {
    assert.deepEqual(qb("t").toSql(), { text: 'SELECT * FROM "t"', values: [] });
  });

  test("select columns with eq filter", () => {
    const { text, values } = qb("docs").select("id, user_id").eq("user_id", "u1").toSql();
    assert.equal(text, 'SELECT id, user_id FROM "docs" WHERE "user_id" = $1');
    assert.deepEqual(values, ["u1"]);
  });

  test("multiple filters are AND-ed", () => {
    const { text, values } = qb("t").select().eq("a", 1).neq("b", 2).gt("c", 3).toSql();
    assert.equal(text, 'SELECT * FROM "t" WHERE "a" = $1 AND "b" <> $2 AND "c" > $3');
    assert.deepEqual(values, [1, 2, 3]);
  });

  test("in filter uses = ANY", () => {
    const { text, values } = qb("t").select().in("id", [1, 2, 3]).toSql();
    assert.equal(text, 'SELECT * FROM "t" WHERE "id" = ANY($1)');
    assert.deepEqual(values, [[1, 2, 3]]);
  });

  test("is null and not-is null", () => {
    assert.equal(qb("t").select().is("x", null).toSql().text, 'SELECT * FROM "t" WHERE "x" IS NULL');
    assert.equal(
      qb("t").select().not("v", "is", null).toSql().text,
      'SELECT * FROM "t" WHERE "v" IS NOT NULL',
    );
    assert.equal(qb("t").select().is("b", true).toSql().text, 'SELECT * FROM "t" WHERE "b" IS TRUE');
  });

  test("order, limit, range", () => {
    assert.equal(
      qb("t").select().order("created_at", { ascending: false }).limit(5).toSql().text,
      'SELECT * FROM "t" ORDER BY "created_at" DESC LIMIT 5',
    );
    assert.equal(
      qb("t").select().order("v", { ascending: false, nullsFirst: false }).toSql().text,
      'SELECT * FROM "t" ORDER BY "v" DESC NULLS LAST',
    );
    assert.equal(
      qb("t").select().range(10, 19).toSql().text,
      'SELECT * FROM "t" LIMIT 10 OFFSET 10',
    );
  });

  test("head count", () => {
    assert.equal(
      qb("t").select("id", { count: "exact", head: true }).eq("u", 1).toSql().text,
      'SELECT count(*)::int AS count FROM "t" WHERE "u" = $1',
    );
  });

  test("insert single (no returning)", () => {
    const { text, values } = qb("t").insert({ a: 1, b: "x" }).toSql();
    assert.equal(text, 'INSERT INTO "t" ("a", "b") VALUES ($1, $2)');
    assert.deepEqual(values, [1, "x"]);
  });

  test("insert then select adds RETURNING", () => {
    const { text } = qb("t").insert({ a: 1 }).select().toSql();
    assert.equal(text, 'INSERT INTO "t" ("a") VALUES ($1) RETURNING *');
  });

  test("multi-row insert uses DEFAULT for missing keys", () => {
    const { text, values } = qb("t").insert([{ a: 1, b: 2 }, { a: 3 }]).toSql();
    assert.equal(text, 'INSERT INTO "t" ("a", "b") VALUES ($1, $2), ($3, DEFAULT)');
    assert.deepEqual(values, [1, 2, 3]);
  });

  test("json/array values are serialized and cast to jsonb", () => {
    const { text, values } = qb("t").insert({ shared_with: ["a@x.com"], meta: { k: 1 } }).toSql();
    assert.equal(text, 'INSERT INTO "t" ("shared_with", "meta") VALUES ($1::jsonb, $2::jsonb)');
    assert.deepEqual(values, ['["a@x.com"]', '{"k":1}']);
  });

  test("scalar string into a jsonb column is serialized and cast ::jsonb", () => {
    // A chat user turn stores its raw message string in the jsonb `content`
    // column; without the ::jsonb cast Postgres rejects the text and the
    // message is silently dropped on insert.
    const { text, values } = qb("chat_messages")
      .insert({ chat_id: "c", role: "user", content: "hello world" })
      .toSql();
    assert.equal(
      text,
      'INSERT INTO "chat_messages" ("chat_id", "role", "content") VALUES ($1, $2, $3::jsonb)',
    );
    assert.deepEqual(values, ["c", "user", '"hello world"']);
  });

  test("scalar values into non-jsonb columns stay bound as text", () => {
    // `role` is a text column, so it must NOT be cast to jsonb.
    const { text, values } = qb("chat_messages")
      .insert({ role: "assistant" })
      .toSql();
    assert.equal(text, 'INSERT INTO "chat_messages" ("role") VALUES ($1)');
    assert.deepEqual(values, ["assistant"]);
  });

  test("update with filter and returning", () => {
    const { text, values } = qb("t").update({ name: "n" }).eq("id", 7).select().toSql();
    assert.equal(text, 'UPDATE "t" SET "name" = $1 WHERE "id" = $2 RETURNING *');
    assert.deepEqual(values, ["n", 7]);
  });

  test("upsert with onConflict merges non-conflict columns", () => {
    const { text } = qb("user_api_keys")
      .upsert({ user_id: "u", provider: "claude", encrypted_key: "e" }, { onConflict: "user_id,provider" })
      .toSql();
    assert.equal(
      text,
      'INSERT INTO "user_api_keys" ("user_id", "provider", "encrypted_key") VALUES ($1, $2, $3) ON CONFLICT ("user_id", "provider") DO UPDATE SET "encrypted_key" = EXCLUDED."encrypted_key"',
    );
  });

  test("upsert ignoreDuplicates uses DO NOTHING", () => {
    const { text } = qb("t").upsert({ a: 1 }, { onConflict: "a", ignoreDuplicates: true }).toSql();
    assert.equal(text, 'INSERT INTO "t" ("a") VALUES ($1) ON CONFLICT ("a") DO NOTHING');
  });

  test("delete with filter", () => {
    const { text, values } = qb("t").delete().eq("id", "z").toSql();
    assert.equal(text, 'DELETE FROM "t" WHERE "id" = $1');
    assert.deepEqual(values, ["z"]);
  });
});

describe("QueryBuilder result shaping", () => {
  const withRows = (rows: Record<string, unknown>[]): QueryExecutor => async () => ({
    rows,
    rowCount: rows.length,
  });

  test("select returns rows as data array", async () => {
    const { data, error } = await new QueryBuilder("t", withRows([{ id: 1 }, { id: 2 }])).select();
    assert.equal(error, null);
    assert.deepEqual(data, [{ id: 1 }, { id: 2 }]);
  });

  test("single returns the row, errors on zero or many", async () => {
    const one = await new QueryBuilder("t", withRows([{ id: 1 }])).select().single();
    assert.deepEqual(one.data, { id: 1 });

    const none = await new QueryBuilder("t", withRows([])).select().single();
    assert.equal(none.data, null);
    assert.equal(none.error?.code, "PGRST116");

    const many = await new QueryBuilder("t", withRows([{ id: 1 }, { id: 2 }])).select().single();
    assert.equal(many.error?.code, "PGRST116");
  });

  test("maybeSingle returns null for zero rows, row for one", async () => {
    const none = await new QueryBuilder("t", withRows([])).select().maybeSingle();
    assert.equal(none.data, null);
    assert.equal(none.error, null);

    const one = await new QueryBuilder("t", withRows([{ id: 9 }])).select().maybeSingle();
    assert.deepEqual(one.data, { id: 9 });
  });

  test("mutation without select yields null data", async () => {
    const { data, error } = await new QueryBuilder("t", withRows([])).insert({ a: 1 });
    assert.equal(error, null);
    assert.equal(data, null);
  });

  test("executor errors are returned, not thrown", async () => {
    const failing: QueryExecutor = async () => {
      throw Object.assign(new Error("boom"), { code: "42703" });
    };
    const { data, error } = await new QueryBuilder("t", failing).select().eq("nope", 1);
    assert.equal(data, null);
    assert.equal(error?.code, "42703");
    assert.equal(error?.message, "boom");
  });

  test("head count returns count and null data", async () => {
    const res = await new QueryBuilder("t", withRows([{ count: 42 }]))
      .select("id", { count: "exact", head: true });
    assert.equal(res.data, null);
    assert.equal(res.count, 42);
  });
});
