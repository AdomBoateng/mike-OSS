import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  OCR_MAX_PAGES,
  ocrAvailable,
  resetOcrBinaryCache,
  resolvePdftoppmPath,
} from "./ocr";

const REAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...REAL_ENV };
  resetOcrBinaryCache();
});

describe("resolvePdftoppmPath", () => {
  test("an explicit override that does not exist resolves to null, not the path", () => {
    // Returning a bogus path would surface as a confusing spawn ENOENT deep in
    // a tool call; resolving to null lets ocrAvailable() report honestly.
    process.env.PDFTOPPM_BINARY_PATH = "/nonexistent/pdftoppm";
    process.env.PATH = "";
    resetOcrBinaryCache();
    assert.equal(resolvePdftoppmPath(), null);
  });

  test("the lookup is memoised", () => {
    resetOcrBinaryCache();
    const first = resolvePdftoppmPath();
    process.env.PATH = "";
    assert.equal(resolvePdftoppmPath(), first, "expected the cached result");
  });
});

describe("ocrAvailable", () => {
  test("OCR_ENABLED=false disables it even when the binary is present", () => {
    process.env.OCR_ENABLED = "false";
    resetOcrBinaryCache();
    assert.equal(ocrAvailable(), false);
  });

  test("false when the binary cannot be found", () => {
    delete process.env.OCR_ENABLED;
    process.env.PDFTOPPM_BINARY_PATH = "/nonexistent/pdftoppm";
    process.env.PATH = "";
    resetOcrBinaryCache();
    assert.equal(ocrAvailable(), false);
  });
});

describe("OCR page cap", () => {
  test("defaults to a bounded number of pages", () => {
    // A 200-page Act at ~14s/page must never be transcribed in one call, so the
    // cap exists to keep a chat turn responsive. The exact number can change;
    // that it is small and finite must not.
    assert.ok(OCR_MAX_PAGES > 0);
    assert.ok(OCR_MAX_PAGES <= 50, `cap unexpectedly large: ${OCR_MAX_PAGES}`);
  });
});
