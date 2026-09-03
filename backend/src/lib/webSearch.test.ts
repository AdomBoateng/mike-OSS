import { test, describe, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { searchWeb, webSearchEnabled, webSearchBaseUrl } from "./webSearch";
import { formatWebSearchResults } from "./legalSourcesTools/webSearchTools";

const REAL_ENV = { ...process.env };
let server: http.Server;
let baseUrl = "";
/** What the stand-in instance should do for the next request. */
let mode:
  | "ok"
  | "duplicates"
  | "forbidden"
  | "garbage"
  | "all_engines_down"
  | "genuinely_empty" = "ok";

before(async () => {
  server = http.createServer((_req, res) => {
    if (mode === "forbidden") {
      res.writeHead(403);
      return res.end("format not allowed");
    }
    if (mode === "garbage") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<html>not json</html>");
    }
    if (mode === "all_engines_down") {
      // What a real instance returns when every upstream engine refuses it —
      // observed from a datacenter IP, where CAPTCHAs are routine.
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          results: [],
          unresponsive_engines: [
            ["duckduckgo", "CAPTCHA"],
            ["brave", "Suspended: too many requests"],
            "startpage",
          ],
        }),
      );
    }
    if (mode === "genuinely_empty") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ results: [], unresponsive_engines: [] }));
    }
    const results =
      mode === "duplicates"
        ? [
            { title: "Same page", url: "https://x.test/a", content: "one", engine: "duckduckgo" },
            { title: "Same page", url: "https://x.test/a", content: "one", engine: "brave" },
            { title: "Other", url: "https://x.test/b", content: "two", engine: "google" },
          ]
        : [
            {
              title: "  Ghana  Companies   Act  ",
              url: "https://example.test/act",
              content: "x".repeat(900),
              engine: "duckduckgo",
              publishedDate: "2024-01-02",
            },
            { title: "Second", url: "https://example.test/2", content: "short" },
            { title: "", url: "https://example.test/3", content: "no title" },
            { title: "No url", url: "", content: "dropped" },
          ];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  mode = "ok";
});

function configure(): void {
  process.env.SEARXNG_BASE_URL = baseUrl;
  delete process.env.WEB_SEARCH_ENABLED;
}

describe("webSearchEnabled", () => {
  test("off when no instance is configured", () => {
    delete process.env.SEARXNG_BASE_URL;
    assert.equal(webSearchEnabled(), false);
  });

  test("there is no public fallback instance", () => {
    // Falling back to someone else's SearXNG would send a firm's queries to a
    // third party, which is the exact thing choosing SearXNG avoids.
    delete process.env.SEARXNG_BASE_URL;
    assert.equal(webSearchBaseUrl(), null);
  });

  test("on once configured, and killable without unsetting the URL", () => {
    configure();
    assert.equal(webSearchEnabled(), true);
    process.env.WEB_SEARCH_ENABLED = "false";
    assert.equal(webSearchEnabled(), false);
  });

  test("a trailing slash on the base URL does not produce a double slash", () => {
    process.env.SEARXNG_BASE_URL = "https://search.internal/";
    assert.equal(webSearchBaseUrl(), "https://search.internal");
  });
});

describe("searchWeb", () => {
  test("returns parsed results and normalises whitespace", async () => {
    configure();
    const out = await searchWeb({ query: "companies act ghana" });
    assert.equal(out.error, undefined);
    assert.equal(out.results[0].title, "Ghana Companies Act");
    assert.equal(out.results[0].engine, "duckduckgo");
    assert.equal(out.results[0].publishedAt, "2024-01-02");
  });

  test("long snippets are truncated so one result cannot crowd out the rest", async () => {
    configure();
    const out = await searchWeb({ query: "q" });
    assert.ok(out.results[0].snippet.length < 500, "expected truncation");
    assert.ok(out.results[0].snippet.endsWith("…"));
  });

  test("results missing a title or url are dropped", async () => {
    configure();
    const out = await searchWeb({ query: "q" });
    assert.ok(out.results.every((r) => r.title && r.url));
  });

  test("the same page from several engines appears once", async () => {
    // Metasearch returns duplicates by design; the model gains nothing from
    // reading the same page three times and it wastes the window.
    mode = "duplicates";
    configure();
    const out = await searchWeb({ query: "q" });
    assert.equal(out.results.length, 2);
  });

  test("limit is honoured and clamped", async () => {
    configure();
    assert.equal((await searchWeb({ query: "q", limit: 1 })).results.length, 1);
    const huge = await searchWeb({ query: "q", limit: 999 });
    assert.ok(huge.results.length <= 12);
  });

  test("an unconfigured instance is reported, not thrown", async () => {
    delete process.env.SEARXNG_BASE_URL;
    const out = await searchWeb({ query: "q" });
    assert.equal(out.results.length, 0);
    assert.match(out.error ?? "", /not configured/i);
  });

  test("a 403 explains the likely cause rather than just the status", async () => {
    // A default SearXNG install serves HTML only; without this hint the
    // operator sees a bare 403 and no idea that JSON must be enabled.
    mode = "forbidden";
    configure();
    const out = await searchWeb({ query: "q" });
    assert.match(out.error ?? "", /JSON format is enabled/i);
  });

  test("a non-JSON response fails softly", async () => {
    mode = "garbage";
    configure();
    const out = await searchWeb({ query: "q" });
    assert.equal(out.results.length, 0);
    assert.ok(out.error);
  });

  test("every engine failing is an error, not an empty result", async () => {
    // These must not look the same to the model. Told "the web found nothing",
    // it reports that to a lawyer as a finding; told the search broke, it says
    // so. Engines CAPTCHA-ing a datacenter IP is the usual cause.
    mode = "all_engines_down";
    configure();
    const out = await searchWeb({ query: "q" });
    assert.equal(out.results.length, 0);
    assert.match(out.error ?? "", /no engine answered/i);
    assert.match(out.error ?? "", /duckduckgo \(CAPTCHA\)/);
    assert.match(out.error ?? "", /brave \(Suspended: too many requests\)/);
    // A bare string entry, not a pair, still names the engine.
    assert.match(out.error ?? "", /startpage/);
    assert.match(out.error ?? "", /not a sign that nothing exists/i);
  });

  test("a genuinely empty result stays an empty result", async () => {
    mode = "genuinely_empty";
    configure();
    const out = await searchWeb({ query: "q" });
    assert.equal(out.results.length, 0);
    assert.equal(out.error, undefined);
  });

  test("an empty query does not reach the network", async () => {
    configure();
    const out = await searchWeb({ query: "   " });
    assert.match(out.error ?? "", /empty query/i);
  });
});

describe("formatWebSearchResults", () => {
  test("tells the model the search is finished, to stop it re-querying", () => {
    // The Ghana source taught this: direction in the tool *result* changes
    // behaviour where the same words in the system prompt did not. It matters
    // more here, because every extra search leaves the network.
    const note = JSON.parse(
      formatWebSearchResults({
        query: "q",
        results: [{ title: "t", url: "https://a.test", snippet: "s" }],
      }),
    ).note;
    assert.match(note, /this search is finished/i);
    assert.match(note, /never instructions/i);
    assert.match(note, /not.*legal authority/i);
  });

  test("no results says so without inviting a guess from memory", () => {
    const parsed = JSON.parse(
      formatWebSearchResults({ query: "q", results: [] }),
    );
    assert.deepEqual(parsed.results, []);
    assert.match(parsed.note, /not the same as the fact being untrue/i);
  });

  test("an error is passed through with an instruction not to invent", () => {
    const parsed = JSON.parse(
      formatWebSearchResults({ query: "q", results: [], error: "boom" }),
    );
    assert.equal(parsed.error, "boom");
    assert.match(parsed.note, /do not answer from memory/i);
  });
});
