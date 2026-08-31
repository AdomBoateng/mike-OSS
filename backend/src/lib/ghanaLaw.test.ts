import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  findInLegislationText,
  ghanaLawBaseUrl,
  ghanaLawEnabled,
  principalActStem,
  resetGhanaLawCache,
  significantWords,
} from "./ghanaLaw";

const REAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...REAL_ENV };
  resetGhanaLawCache();
});

describe("ghanaLawBaseUrl", () => {
  test("defaults to the Parliament repository API", () => {
    delete process.env.GHANA_LAW_BASE_URL;
    assert.equal(ghanaLawBaseUrl(), "https://repository.parliament.gh/server/api");
  });

  test("an override wins and its trailing slashes are trimmed", () => {
    process.env.GHANA_LAW_BASE_URL = "http://mirror.internal/server/api///";
    assert.equal(ghanaLawBaseUrl(), "http://mirror.internal/server/api");
  });
});

describe("ghanaLawEnabled", () => {
  test("on by default — the API needs no key", () => {
    delete process.env.GHANA_LAW_ENABLED;
    assert.equal(ghanaLawEnabled(), true);
  });

  test("explicitly disabled", () => {
    process.env.GHANA_LAW_ENABLED = "false";
    assert.equal(ghanaLawEnabled(), false);
  });
});

/** Two pages of pseudo-Act text in extractPdfText's output shape. */
const ACT = [
  "[Page 1]",
  "COMPANIES ACT, 2019 (ACT 992) Section 1. Application of Act. This Act applies to every company.",
  "",
  "[Page 2]",
  "Section 12. A director shall act in good faith. A director who fails to act in good faith commits an offence.",
].join("\n");

describe("findInLegislationText", () => {
  test("returns the matching excerpt with its page number", () => {
    const hits = findInLegislationText(ACT, "good faith");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].page, 2);
    assert.match(hits[0].excerpt, /good faith/);
  });

  test("attributes a first-page hit to page 1", () => {
    const hits = findInLegislationText(ACT, "Application of Act");
    assert.equal(hits[0].page, 1);
  });

  test("matching is case-insensitive", () => {
    assert.ok(findInLegislationText(ACT, "COMPANIES act").length > 0);
  });

  test("finds every occurrence, not just the first", () => {
    // "good faith" appears twice on page 2.
    assert.equal(findInLegislationText(ACT, "good faith").length, 2);
  });

  test("respects maxMatches", () => {
    const many = "term ".repeat(50);
    assert.equal(findInLegislationText(many, "term", { maxMatches: 3 }).length, 3);
  });

  test("caps maxMatches so a model cannot request an unbounded dump", () => {
    const many = "term ".repeat(500);
    assert.equal(
      findInLegislationText(many, "term", { maxMatches: 9999 }).length,
      25,
    );
  });

  test("no match yields no hits rather than throwing", () => {
    assert.deepEqual(findInLegislationText(ACT, "cryptocurrency"), []);
  });

  test("an empty or whitespace query returns nothing", () => {
    assert.deepEqual(findInLegislationText(ACT, "   "), []);
  });

  test("excerpts are whitespace-collapsed for readable tool output", () => {
    const hits = findInLegislationText("[Page 1]\nalpha   \n\n  beta", "beta");
    assert.ok(!/\s\s/.test(hits[0].excerpt));
  });

  test("context width is bounded even when asked for more", () => {
    const long = "x".repeat(50000) + "needle" + "y".repeat(50000);
    const hits = findInLegislationText(long, "needle", { contextChars: 99999 });
    assert.ok(hits[0].excerpt.length <= 4100);
  });

  test("text with no page markers still matches, with a null page", () => {
    const hits = findInLegislationText("no markers here, just needle text", "needle");
    assert.equal(hits[0].page, null);
  });
});

describe("principalActStem", () => {
  test("keeps the distinguishing words and drops Act, year and brackets", () => {
    assert.equal(
      principalActStem("National Health Insurance Act, 2003 (Act 650)"),
      "national health insurance",
    );
    assert.equal(principalActStem("Companies Act, 2019 (ACT 992)"), "companies");
  });

  test("handles a bare short title", () => {
    assert.equal(principalActStem("Companies"), "companies");
  });
});

describe("significantWords", () => {
  test("drops filler words that would match anything", () => {
    assert.deepEqual(
      significantWords("commission of inquiry and the transfer"),
      ["commission", "inquiry", "transfer"],
    );
  });
});
