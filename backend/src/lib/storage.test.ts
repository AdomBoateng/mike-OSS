import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveStorageConfig,
  isStorageEnabled,
  normalizeDownloadFilename,
  sanitizeDispositionFilename,
  encodeRFC5987,
  buildContentDisposition,
  storageKey,
  pdfStorageKey,
  generatedDocKey,
  versionStorageKey,
} from "./storage";

// Env vars this module reads. Cleared before each test and restored after so
// tests are hermetic and independent of the developer's shell / .env.
const STORAGE_ENV_VARS = [
  "S3_ENDPOINT_URL",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET_NAME",
  "S3_REGION",
  "S3_FORCE_PATH_STYLE",
  "R2_ENDPOINT_URL",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_REGION",
  "R2_FORCE_PATH_STYLE",
] as const;

describe("resolveStorageConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of STORAGE_ENV_VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of STORAGE_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("returns null when nothing is configured", () => {
    assert.equal(resolveStorageConfig(), null);
    assert.equal(isStorageEnabled(), false);
  });

  test("returns null when a required field is missing", () => {
    process.env.S3_ENDPOINT_URL = "https://s3.example";
    process.env.S3_ACCESS_KEY_ID = "key";
    // secret access key intentionally missing
    assert.equal(resolveStorageConfig(), null);
    assert.equal(isStorageEnabled(), false);
  });

  test("reads S3_* names with sensible defaults", () => {
    process.env.S3_ENDPOINT_URL = "https://s3.example.internal";
    process.env.S3_ACCESS_KEY_ID = "ak";
    process.env.S3_SECRET_ACCESS_KEY = "sk";

    const config = resolveStorageConfig();
    assert.deepEqual(config, {
      endpoint: "https://s3.example.internal",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      bucket: "mike",
      region: "auto",
      forcePathStyle: true,
    });
    assert.equal(isStorageEnabled(), true);
  });

  test("falls back to legacy R2_* names", () => {
    process.env.R2_ENDPOINT_URL = "https://acct.r2.cloudflarestorage.com";
    process.env.R2_ACCESS_KEY_ID = "r2ak";
    process.env.R2_SECRET_ACCESS_KEY = "r2sk";
    process.env.R2_BUCKET_NAME = "legacy-bucket";

    const config = resolveStorageConfig();
    assert.equal(config?.endpoint, "https://acct.r2.cloudflarestorage.com");
    assert.equal(config?.accessKeyId, "r2ak");
    assert.equal(config?.secretAccessKey, "r2sk");
    assert.equal(config?.bucket, "legacy-bucket");
  });

  test("S3_* takes precedence over R2_*", () => {
    process.env.R2_ENDPOINT_URL = "https://r2.example";
    process.env.R2_ACCESS_KEY_ID = "r2ak";
    process.env.R2_SECRET_ACCESS_KEY = "r2sk";
    process.env.R2_BUCKET_NAME = "r2-bucket";
    process.env.S3_ENDPOINT_URL = "https://surf.example";
    process.env.S3_ACCESS_KEY_ID = "s3ak";
    process.env.S3_SECRET_ACCESS_KEY = "s3sk";
    process.env.S3_BUCKET_NAME = "surf-bucket";

    const config = resolveStorageConfig();
    assert.equal(config?.endpoint, "https://surf.example");
    assert.equal(config?.accessKeyId, "s3ak");
    assert.equal(config?.secretAccessKey, "s3sk");
    assert.equal(config?.bucket, "surf-bucket");
  });

  test("treats whitespace-only values as missing", () => {
    process.env.S3_ENDPOINT_URL = "   ";
    process.env.S3_ACCESS_KEY_ID = "ak";
    process.env.S3_SECRET_ACCESS_KEY = "sk";
    assert.equal(resolveStorageConfig(), null);
  });

  test("trims surrounding whitespace on values", () => {
    process.env.S3_ENDPOINT_URL = "  https://s3.example  ";
    process.env.S3_ACCESS_KEY_ID = "  ak  ";
    process.env.S3_SECRET_ACCESS_KEY = "  sk  ";
    const config = resolveStorageConfig();
    assert.equal(config?.endpoint, "https://s3.example");
    assert.equal(config?.accessKeyId, "ak");
    assert.equal(config?.secretAccessKey, "sk");
  });

  test("honors S3_REGION and S3_FORCE_PATH_STYLE overrides", () => {
    process.env.S3_ENDPOINT_URL = "https://s3.example";
    process.env.S3_ACCESS_KEY_ID = "ak";
    process.env.S3_SECRET_ACCESS_KEY = "sk";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_FORCE_PATH_STYLE = "false";

    const config = resolveStorageConfig();
    assert.equal(config?.region, "us-east-1");
    assert.equal(config?.forcePathStyle, false);
  });

  test("forcePathStyle defaults to true for any value other than 'false'", () => {
    process.env.S3_ENDPOINT_URL = "https://s3.example";
    process.env.S3_ACCESS_KEY_ID = "ak";
    process.env.S3_SECRET_ACCESS_KEY = "sk";
    process.env.S3_FORCE_PATH_STYLE = "true";
    assert.equal(resolveStorageConfig()?.forcePathStyle, true);
  });
});

describe("filename helpers", () => {
  test("normalizeDownloadFilename strips control chars and path separators", () => {
    assert.equal(normalizeDownloadFilename("report.docx"), "report.docx");
    assert.equal(normalizeDownloadFilename("  spaced.pdf  "), "spaced.pdf");
    assert.equal(normalizeDownloadFilename(""), "download");
    assert.equal(normalizeDownloadFilename("   "), "download");
    assert.equal(normalizeDownloadFilename("a/b\\c.txt"), "a_b_c.txt");
    assert.equal(normalizeDownloadFilename("tab\tname.txt"), "tab_name.txt");
  });

  test("sanitizeDispositionFilename escapes quotes and non-ascii", () => {
    assert.equal(sanitizeDispositionFilename('a"b.txt'), "a_b.txt");
    assert.equal(sanitizeDispositionFilename("a\\b.txt"), "a_b.txt");
    assert.equal(sanitizeDispositionFilename("café.txt"), "caf_.txt");
  });

  test("encodeRFC5987 percent-encodes reserved characters", () => {
    assert.equal(encodeRFC5987("café.txt"), "caf%C3%A9.txt");
    assert.equal(encodeRFC5987("a b(c).txt"), "a%20b%28c%29.txt");
  });

  test("buildContentDisposition emits both filename and filename*", () => {
    const header = buildContentDisposition("attachment", "café report.docx");
    assert.match(header, /^attachment; /);
    assert.match(header, /filename="caf_ report\.docx"/);
    assert.match(header, /filename\*=UTF-8''caf%C3%A9%20report\.docx/);
  });

  test("buildContentDisposition supports inline disposition", () => {
    const header = buildContentDisposition("inline", "preview.pdf");
    assert.match(header, /^inline; filename="preview\.pdf"/);
  });
});

describe("storage key helpers", () => {
  const userId = "user-1";
  const docId = "doc-1";

  test("storageKey preserves a known extension", () => {
    assert.equal(
      storageKey(userId, docId, "brief.docx"),
      "documents/user-1/doc-1/source.docx",
    );
  });

  test("storageKey falls back to .bin for missing/odd extensions", () => {
    assert.equal(
      storageKey(userId, docId, "noext"),
      "documents/user-1/doc-1/source.bin",
    );
  });

  test("pdfStorageKey builds the expected path", () => {
    assert.equal(
      pdfStorageKey(userId, docId, "rendition"),
      "documents/user-1/doc-1/rendition.pdf",
    );
  });

  test("generatedDocKey defaults to .docx", () => {
    assert.equal(
      generatedDocKey(userId, docId, "output"),
      "generated/user-1/doc-1/generated.docx",
    );
  });

  test("versionStorageKey includes the version slug", () => {
    assert.equal(
      versionStorageKey(userId, docId, "v3", "draft.docx"),
      "documents/user-1/doc-1/versions/v3.docx",
    );
  });
});
