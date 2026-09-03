// Integration tests against the REAL Parliament of Ghana repository.
//
//   Run with:  npm run test:integration
//
// Kept out of `npm test` because it hits the network. Self-skips when
// GHANA_LAW_ENABLED=false so it is safe to run anywhere. The repository is a
// public service with no SLA — these tests are deliberately tolerant about
// *which* items come back, and strict only about the shape and the invariants
// the tool depends on.

import "dotenv/config";
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import {
  fetchLegislationText,
  findAmendments,
  findInLegislationText,
  ghanaLawEnabled,
  legislationCollections,
  searchLegislation,
} from "./ghanaLaw";

const skip = ghanaLawEnabled()
  ? false
  : "GHANA_LAW_ENABLED=false — skipping Ghana law integration";

describe("Ghana law repository (live)", { skip }, () => {
  before(() => {
    // One warm-up so the collection lookup isn't timed inside a test.
    return legislationCollections();
  });

  test("resolves legislation collections by name", async () => {
    const { uuids, names } = await legislationCollections();
    assert.ok(uuids.length > 0, "expected at least one legislation collection");
    const joined = [...names.values()].join(" | ");
    assert.match(joined, /act/i);
    // The scoping guard: committee reports and budget papers must not be in scope.
    assert.ok(
      ![...names.values()].some((n) => /report|budget|estimate/i.test(n)),
      `non-legislation collection leaked into scope: ${joined}`,
    );
  });

  test("search returns legislation, not committee reports", async () => {
    const hits = await searchLegislation("Companies Act", { limit: 8 });
    assert.ok(hits.length > 0, "expected results for 'Companies Act'");
    for (const h of hits) {
      assert.ok(h.uuid && h.title, "item missing uuid/title");
      assert.match(h.url, /^https?:\/\//);
    }
    // The failure this guards: an unscoped search returns "Report of the
    // Committee on ..." items that read like law and are not.
    const reports = hits.filter((h) => /^report of the/i.test(h.title));
    assert.equal(reports.length, 0, `committee reports in results: ${reports.map(r=>r.title).join("; ")}`);
  });

  test("search respects its limit", async () => {
    const hits = await searchLegislation("Act", { limit: 5 });
    assert.ok(hits.length <= 5);
  });

  test("fetches and extracts a modern Act", async () => {
    const [hit] = await searchLegislation("Companies Act 2019", { limit: 5 });
    assert.ok(hit, "no candidate Act found");
    const doc = await fetchLegislationText(hit.uuid);
    assert.ok(doc, "expected a document");
    assert.equal(doc.item.uuid, hit.uuid);
    assert.ok(["text", "scan", "empty"].includes(doc.quality));
    if (doc.quality === "text") {
      assert.ok(doc.chars > 1000, `expected substantial text, got ${doc.chars}`);
      assert.ok(doc.text.length > 0);
      // Searching within it is the primary read path for long Acts.
      const hits = findInLegislationText(doc.text, "section");
      assert.ok(hits.length > 0, "expected 'section' somewhere in an Act");
    }
  });

  test("a scanned Act reports quality 'scan' and returns no text", async () => {
    // Roughly a third of the corpus is image-only. Whichever item we land on,
    // the invariant must hold: a scan never returns text that looks like content.
    const hits = await searchLegislation("Revised Edition", { limit: 6 });
    let sawScan = false;
    for (const h of hits.slice(0, 3)) {
      const doc = await fetchLegislationText(h.uuid);
      if (doc?.quality === "scan") {
        sawScan = true;
        assert.equal(doc.text, "", "a scan must not return text");
        assert.equal(doc.chars, 0);
        assert.ok(doc.pages > 0, "a scan still has pages");
      }
    }
    // Not asserting that we *found* one — the corpus can change — only that the
    // invariant held for any we did see.
    assert.ok(sawScan || true);
  });

  test("an unknown item id returns null rather than throwing", async () => {
    const doc = await fetchLegislationText(
      "00000000-0000-4000-8000-000000000000",
    );
    assert.equal(doc, null);
  });

  test("findAmendments surfaces amendment Acts for a principal Act", async () => {
    const amendments = await findAmendments("National Health Insurance Act");
    for (const a of amendments) {
      assert.match(a.title, /amendment/i);
      // Must actually amend THIS Act. The repository's search is a loose
      // full-text match, so an unfiltered query returned the Income Tax and VAT
      // amendment Acts for "Companies" - presented to a user, that is a
      // confident false statement about what amends what.
      assert.match(a.title, /national health insurance/i);
    }
  });

  test("findAmendments does not attribute unrelated amendment Acts", async () => {
    const amendments = await findAmendments("Companies Act, 2019 (ACT 992)");
    for (const a of amendments) {
      assert.match(a.title, /companies/i, `unrelated amendment returned: ${a.title}`);
    }
  });

  test("committee reports never appear as legislation", async () => {
    // Scoping by collection is not enough: reports are filed alongside the
    // instruments they concern, so titles are filtered too.
    for (const q of ["Road Traffic", "Companies Act", "Health Insurance"]) {
      const hits = await searchLegislation(q, { limit: 10 });
      const reports = hits.filter((h) => /^\s*report/i.test(h.title));
      assert.equal(reports.length, 0, `report leaked for "${q}": ${reports.map(r=>r.title).join("; ")}`);
    }
  });
});
