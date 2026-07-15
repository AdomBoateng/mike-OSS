// Integration smoke-test for S3-compatible storage (self-hosted "surf", MinIO,
// AWS S3, or R2). Unlike storage.test.ts (pure unit tests, always run), this
// hits a REAL storage backend and is intentionally kept OUT of the default
// `npm test` run.
//
//   Run with:  npm run test:integration
//
// It loads .env, so point your S3_* (or legacy R2_*) vars at the target
// backend first. When storage is not configured, every check is skipped rather
// than failing — so it is safe to run in any environment.
//
// What it verifies (things a self-hosted endpoint can silently get wrong):
//   1. Round-trip: upload -> download returns identical bytes
//   2. listFiles sees the uploaded key
//   3. Presigned GET URL is fetchable and returns the bytes
//   4. Presigned URL honors ResponseContentDisposition (download filename)
//   5. delete removes the object (download -> null, list -> absent)
//
// NOTE: browser CORS cannot be verified from Node. After this passes, still
// confirm from the browser that signed-URL fetches succeed cross-origin.

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  isStorageEnabled,
  resolveStorageConfig,
  uploadFile,
  downloadFile,
  listFiles,
  deleteFile,
  getSignedUrl,
} from "./storage";

const enabled = isStorageEnabled();
const skip = enabled
  ? false
  : "storage not configured (set S3_* or R2_* env vars) — skipping";

// Namespaced under a dedicated prefix so a stray failure never touches real
// document data, and cleaned up in `after` regardless of outcome.
const runId = randomUUID();
const key = `__smoketest__/${runId}/source.txt`;
const downloadName = "smoke test résumé.txt";
const payload = new TextEncoder().encode(`mike storage smoke test ${runId}`);
const payloadBuffer = payload.buffer.slice(
  payload.byteOffset,
  payload.byteOffset + payload.byteLength,
) as ArrayBuffer;

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  return true;
}

describe("storage integration (real backend)", { skip }, () => {
  before(() => {
    const config = resolveStorageConfig();
    console.log(
      `[integration] endpoint=${config?.endpoint} bucket=${config?.bucket} ` +
        `region=${config?.region} forcePathStyle=${config?.forcePathStyle}`,
    );
  });

  after(async () => {
    // Best-effort cleanup; ignore errors so a mid-test failure still tidies up.
    try {
      await deleteFile(key);
    } catch {
      /* ignore */
    }
  });

  test("upload then download returns identical bytes", async () => {
    await uploadFile(key, payloadBuffer, "text/plain");
    const roundTripped = await downloadFile(key);
    assert.ok(roundTripped, "downloadFile returned null after upload");
    assert.ok(
      bytesEqual(roundTripped, payloadBuffer),
      "downloaded bytes differ from uploaded bytes",
    );
  });

  test("listFiles includes the uploaded key", async () => {
    const keys = await listFiles(`__smoketest__/${runId}/`);
    assert.ok(
      keys.includes(key),
      `expected ${key} in listing, got: ${keys.join(", ")}`,
    );
  });

  test("presigned URL is fetchable and returns the bytes", async () => {
    const url = await getSignedUrl(key, 300);
    assert.ok(url, "getSignedUrl returned null");
    const res = await fetch(url);
    assert.equal(res.status, 200, `presigned GET failed: HTTP ${res.status}`);
    const body = await res.arrayBuffer();
    assert.ok(
      bytesEqual(body, payloadBuffer),
      "presigned URL body differs from uploaded bytes",
    );
  });

  test("presigned URL honors ResponseContentDisposition", async () => {
    const url = await getSignedUrl(key, 300, downloadName);
    assert.ok(url, "getSignedUrl returned null");
    const res = await fetch(url);
    assert.equal(res.status, 200, `presigned GET failed: HTTP ${res.status}`);
    const disposition = res.headers.get("content-disposition") ?? "";
    // buildContentDisposition emits an ascii `filename` and a UTF-8 `filename*`.
    assert.match(
      disposition,
      /attachment/i,
      `expected attachment disposition, got: "${disposition}"`,
    );
    assert.match(
      disposition,
      /filename\*=UTF-8''/i,
      `endpoint did not echo ResponseContentDisposition; got: "${disposition}"`,
    );
    // Drain the body so the connection is released.
    await res.arrayBuffer();
  });

  test("delete removes the object", async () => {
    await deleteFile(key);
    const afterDelete = await downloadFile(key);
    assert.equal(afterDelete, null, "object still downloadable after delete");
    const keys = await listFiles(`__smoketest__/${runId}/`);
    assert.ok(!keys.includes(key), "object still listed after delete");
  });
});
