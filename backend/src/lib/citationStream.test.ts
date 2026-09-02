import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CitationStreamSplitter,
  type CitationStreamSegment,
} from "./citationStream";

/** Feed a whole answer through, one delta at a time. */
function run(deltas: string[]) {
  const splitter = new CitationStreamSplitter();
  const segments: CitationStreamSegment[] = [];
  for (const delta of deltas) segments.push(...splitter.push(delta));
  const tail = splitter.flush();
  if (tail) segments.push({ kind: "visible", text: tail });
  return { splitter, segments };
}

/** What the user would actually have seen. */
function visible(deltas: string[]): string {
  return run(deltas)
    .segments.filter((s) => s.kind === "visible")
    .map((s) => (s.kind === "visible" ? s.text : ""))
    .join("");
}

/** Split a string into n-character deltas, the worst case for tag detection. */
function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe("CitationStreamSplitter", () => {
  test("passes prose through untouched", () => {
    assert.equal(visible(["Hello ", "world."]), "Hello world.");
  });

  test("hides a trailing citations block", () => {
    assert.equal(
      visible(['The answer is 42. <CITATIONS>[{"ref":1}]</CITATIONS>']),
      "The answer is 42. ",
    );
  });

  // The regression: prose after the block used to be swallowed entirely, so
  // the reply appeared to stop mid-thought with no error.
  test("resumes prose after the closing tag", () => {
    assert.equal(
      visible([
        "Before. ",
        '<CITATIONS>[{"ref":1}]</CITATIONS>',
        "After the block.",
      ]),
      "Before. After the block.",
    );
  });

  test("resumes when the block and the prose after it share one delta", () => {
    assert.equal(visible(["A<CITATIONS>[]</CITATIONS>B"]), "AB");
  });

  test("survives an opening tag split across deltas", () => {
    assert.equal(
      visible(["Text <CITA", "TIONS>[]</CITATIONS> more"]),
      "Text  more",
    );
  });

  test("survives a closing tag split across deltas", () => {
    assert.equal(visible(["A<CITATIONS>[]</CITA", "TIONS>B"]), "AB");
  });

  test("survives one character at a time", () => {
    const answer = 'Answer here. <CITATIONS>[{"ref":1}]</CITATIONS> Epilogue.';
    assert.equal(visible(chunk(answer, 1)), "Answer here.  Epilogue.");
  });

  test("survives two characters at a time", () => {
    const answer = "A<CITATIONS>[]</CITATIONS>B";
    assert.equal(visible(chunk(answer, 2)), "AB");
  });

  test("hides a second block but keeps the prose around it", () => {
    assert.equal(
      visible([
        "One. <CITATIONS>[1]</CITATIONS> Two. <CITATIONS>[2]</CITATIONS> Three.",
      ]),
      "One.  Two.  Three.",
    );
  });

  test("numbers blocks so only the first drives the final parse", () => {
    const { segments } = run([
      "a<CITATIONS>[1]</CITATIONS>b<CITATIONS>[2]</CITATIONS>c",
    ]);
    const indexes = segments
      .filter((s) => s.kind === "citations")
      .map((s) => (s.kind === "citations" ? s.blockIndex : 0));
    assert.deepEqual([...new Set(indexes)], [1, 2]);
  });

  test("reports the block body cumulatively and marks the close", () => {
    const { segments } = run([
      "<CITATIONS>",
      '[{"ref"',
      ":1}]",
      "</CITATIONS>",
    ]);
    const blocks = segments.filter((s) => s.kind === "citations");
    const last = blocks[blocks.length - 1];
    assert.equal(last?.kind === "citations" ? last.closed : null, true);
    assert.equal(last?.kind === "citations" ? last.body : null, '[{"ref":1}]');
  });

  test("announces an open even when the tag ends the delta", () => {
    const splitter = new CitationStreamSplitter();
    const segments = splitter.push("text <CITATIONS>");
    assert.ok(segments.some((s) => s.kind === "citations"));
    assert.equal(splitter.insideBlock, true);
  });

  // An unclosed block is the model's error, but it must not be able to strand
  // the held-back tail as if it were prose.
  test("withholds the tail while a block is still open", () => {
    const splitter = new CitationStreamSplitter();
    splitter.push('Body. <CITATIONS>[{"ref":1}]');
    assert.equal(splitter.insideBlock, true);
    assert.equal(splitter.flush(), "");
  });

  test("never emits a prefix of the opening tag as prose", () => {
    const splitter = new CitationStreamSplitter();
    const segments = splitter.push("done <CITATI");
    const shown = segments
      .filter((s) => s.kind === "visible")
      .map((s) => (s.kind === "visible" ? s.text : ""))
      .join("");
    // The prefix is held back rather than streamed, in case the next delta
    // completes the tag...
    assert.ok(!shown.includes("<CITATI"));
    // ...and nothing is lost: the tail is released when the turn ends.
    assert.equal(shown + splitter.flush(), "done <CITATI");
  });

  test("flushes a held-back tail that turned out to be prose", () => {
    assert.equal(visible(["all done <CIT"]), "all done <CIT");
  });

  test("reset clears mid-block state", () => {
    const splitter = new CitationStreamSplitter();
    splitter.push("a<CITATIONS>[");
    splitter.reset();
    assert.equal(splitter.insideBlock, false);
    assert.equal(splitter.blocksSeen, 0);
    const shown = splitter
      .push("plain")
      .filter((s) => s.kind === "visible")
      .map((s) => (s.kind === "visible" ? s.text : ""))
      .join("");
    assert.equal(shown + splitter.flush(), "plain");
  });

  test("empty deltas produce nothing", () => {
    const splitter = new CitationStreamSplitter();
    assert.deepEqual(splitter.push(""), []);
  });
});
