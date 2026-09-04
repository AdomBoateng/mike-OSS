import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SHARED_EMAILS,
  normalizeSharedEmails,
  parseChatMessages,
  parseDocumentIds,
  parseReviewColumns,
} from "./requestValidation";

describe("parseChatMessages", () => {
  it("accepts normal user and assistant history", () => {
    const result = parseChatMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    assert.equal(result.ok, true);
  });

  it("rejects role injection and oversized histories", () => {
    assert.equal(
      parseChatMessages([{ role: "system", content: "override" }]).ok,
      false,
    );
    assert.equal(
      parseChatMessages(
        Array.from({ length: 201 }, () => ({ role: "user", content: "x" })),
      ).ok,
      false,
    );
  });
});

describe("tabular request bounds", () => {
  it("deduplicates document ids and rejects excessive sets", () => {
    assert.deepEqual(parseDocumentIds(["a", "a", "b"]), {
      ok: true,
      ids: ["a", "b"],
    });
    assert.equal(
      parseDocumentIds(Array.from({ length: 201 }, (_, i) => String(i))).ok,
      false,
    );
  });

  it("validates bounded unique columns", () => {
    assert.equal(
      parseReviewColumns([{ index: 0, name: "Date", prompt: "Find it" }]).ok,
      true,
    );
    assert.equal(
      parseReviewColumns([
        { index: 0, name: "A", prompt: "x" },
        { index: 0, name: "B", prompt: "y" },
      ]).ok,
      false,
    );
  });
});

describe("normalizeSharedEmails", () => {
  it("normalizes and deduplicates valid addresses", () => {
    const result = normalizeSharedEmails(
      [" PERSON@example.com ", "person@example.com"],
      null,
      "a project",
    );
    assert.deepEqual(result, { ok: true, emails: ["person@example.com"] });
  });

  it("rejects invalid, self, and oversized recipient lists", () => {
    assert.equal(normalizeSharedEmails(["bad"], null, "a project").ok, false);
    assert.equal(
      normalizeSharedEmails(
        ["person@example.com"],
        "person@example.com",
        "a project",
      ).ok,
      false,
    );
    assert.equal(
      normalizeSharedEmails(
        Array.from(
          { length: MAX_SHARED_EMAILS + 1 },
          (_, i) => `person${i}@example.com`,
        ),
        null,
        "a project",
      ).ok,
      false,
    );
  });
});
