import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { assessExtractedText } from "./pdfText";

/** Build extractPdfText-shaped output: one [Page N] block per page. */
function pages(...bodies: string[]): string {
  return bodies.map((b, i) => `[Page ${i + 1}]\n${b}`).join("\n\n");
}

describe("assessExtractedText", () => {
  test("a real page of legislation is text", () => {
    const a = assessExtractedText(pages("Section 1. ".repeat(200)));
    assert.equal(a.quality, "text");
    assert.equal(a.pages, 1);
    assert.ok(a.charsPerPage > 1000);
  });

  test("a scanned PDF — page markers, no content — is a scan, not empty", () => {
    // This is exactly what the 1970 Act in the repository returns: eight pages
    // of nothing. Reporting it as "no content" would let a caller treat it as
    // an empty document rather than an unreadable one.
    const a = assessExtractedText(pages("", "", "", "", "", "", "", ""));
    assert.equal(a.quality, "scan");
    assert.equal(a.pages, 8);
    assert.equal(a.chars, 0);
  });

  test("a failed extraction with no pages at all is empty", () => {
    const a = assessExtractedText("");
    assert.equal(a.quality, "empty");
    assert.equal(a.pages, 0);
  });

  test("stray OCR speckle across many pages still counts as a scan", () => {
    const a = assessExtractedText(pages(...Array(20).fill("3")));
    assert.equal(a.quality, "scan");
  });

  test("page markers are excluded from the character count", () => {
    const a = assessExtractedText(pages("abc"));
    assert.equal(a.chars, 3);
  });

  test("charsPerPage averages across pages, so one good page cannot carry a scan", () => {
    const a = assessExtractedText(pages("x".repeat(500), ...Array(40).fill("")));
    assert.equal(a.quality, "scan");
    assert.ok(a.charsPerPage < 40);
  });

  test("a short but genuine single page is not misread as a scan", () => {
    const a = assessExtractedText(pages("This Act may be cited as the Sample Act, 2026."));
    assert.equal(a.quality, "text");
  });
});
