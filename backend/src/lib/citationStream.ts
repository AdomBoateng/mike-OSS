// Splitting an assistant's streamed text into prose and <CITATIONS> blocks.
//
// The model is asked to append a <CITATIONS> JSON block to answers that cite
// sources. That block must not reach the user, but everything around it must:
// the block is a trailer by convention only, and models — small local ones
// especially — put prose after it, emit the tag early, or emit it more than
// once. Treating the opening tag as a point of no return silently swallowed
// the rest of the answer, which reads to the user as a reply that stops
// mid-sentence with no error.
//
// Kept separate from chatTools.ts because the tag can straddle any number of
// deltas, which is the part that has to be right and the part that is
// impossible to check from inside a closure.

export const CITATIONS_OPEN_TAG = "<CITATIONS>";
export const CITATIONS_CLOSE_TAG = "</CITATIONS>";

export type CitationStreamSegment =
  /** Prose. Safe to stream straight to the user. */
  | { kind: "visible"; text: string }
  /**
   * Content inside a <CITATIONS> block. `body` is the block's text so far
   * (cumulative, not just this delta's fragment) so a caller can re-run a
   * partial parse over it; `closed` marks the delta that completed the block.
   * `blockIndex` is 1-based — only block 1 is what the final, authoritative
   * parse reads, since CITATIONS_BLOCK_RE is non-global.
   */
  | {
      kind: "citations";
      blockIndex: number;
      body: string;
      closed: boolean;
    };

export class CitationStreamSplitter {
  /**
   * Text held back because it could be the start of an opening tag. Never
   * longer than the tag minus one character, and never a complete tag.
   */
  private tail = "";
  private inside = false;
  private blocks = 0;
  private body = "";

  /** True while a block is open, i.e. output is currently being withheld. */
  get insideBlock(): boolean {
    return this.inside;
  }

  /** How many blocks have opened so far this turn. */
  get blocksSeen(): number {
    return this.blocks;
  }

  push(delta: string): CitationStreamSegment[] {
    const out: CitationStreamSegment[] = [];
    let rest = delta;

    while (rest) {
      if (this.inside) {
        this.body += rest;
        const closeIdx = this.body.indexOf(CITATIONS_CLOSE_TAG);
        if (closeIdx < 0) {
          // A partial closing tag needs no special handling: the whole block
          // stays buffered, so the tag is simply not found yet.
          out.push({
            kind: "citations",
            blockIndex: this.blocks,
            body: this.body,
            closed: false,
          });
          break;
        }
        out.push({
          kind: "citations",
          blockIndex: this.blocks,
          body: this.body.slice(0, closeIdx),
          closed: true,
        });
        rest = this.body.slice(closeIdx + CITATIONS_CLOSE_TAG.length);
        this.inside = false;
        this.body = "";
        continue;
      }

      const combined = this.tail + rest;
      this.tail = "";
      const openIdx = combined.indexOf(CITATIONS_OPEN_TAG);
      if (openIdx >= 0) {
        const visible = combined.slice(0, openIdx);
        if (visible) out.push({ kind: "visible", text: visible });
        this.inside = true;
        this.blocks += 1;
        this.body = "";
        rest = combined.slice(openIdx + CITATIONS_OPEN_TAG.length);
        // Announce the open even when nothing followed it in this delta, so
        // the caller can start a citations snapshot at the right moment.
        if (!rest) {
          out.push({
            kind: "citations",
            blockIndex: this.blocks,
            body: "",
            closed: false,
          });
        }
        continue;
      }

      // Hold back enough of the tail to recognise an opening tag split across
      // this delta and the next.
      const keep = Math.min(CITATIONS_OPEN_TAG.length - 1, combined.length);
      const visible = combined.slice(0, combined.length - keep);
      this.tail = combined.slice(combined.length - keep);
      if (visible) out.push({ kind: "visible", text: visible });
      break;
    }

    return out;
  }

  /**
   * Release the held-back tail at end of turn. It cannot be a complete tag, so
   * it is prose — unless a block is still open, in which case it belongs to
   * the block and the caller should discard it.
   */
  flush(): string {
    const tail = this.tail;
    this.tail = "";
    return this.inside ? "" : tail;
  }

  /** Start a fresh turn. */
  reset(): void {
    this.tail = "";
    this.inside = false;
    this.blocks = 0;
    this.body = "";
  }
}
