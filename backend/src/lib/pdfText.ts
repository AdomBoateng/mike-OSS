// PDF text extraction, split out of chatTools.ts so modules that need it don't
// have to pull in the whole assistant loop — and so tool sources that chatTools
// itself imports (e.g. ghanaLaw.ts) can use it without a circular import.
//
// chatTools re-exports `extractPdfText` for its existing callers.

import path from "path";

const STANDARD_FONT_DATA_URL = (() => {
  try {
    const pkgPath = require.resolve("pdfjs-dist/package.json");
    return path.join(path.dirname(pkgPath), "standard_fonts") + path.sep;
  } catch {
    return undefined;
  }
})();

/**
 * Extract text from a PDF, one `[Page N]` block per page.
 *
 * Returns "" on any failure — callers cannot distinguish a broken file from an
 * image-only scan by the return value alone, so anything that cares about the
 * difference should measure the result (see `assessExtractedText`).
 */
export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{
            numPages: number;
            getPage: (n: number) => Promise<{
              getTextContent: () => Promise<{
                items: { str?: string }[];
              }>;
            }>;
          }>;
        };
      }
    ).getDocument({
      data: new Uint8Array(buf),
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    }).promise;
    const parts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      parts.push(
        `[Page ${i}]\n${textContent.items.map((it) => it.str ?? "").join(" ")}`,
      );
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

export type TextQuality = "text" | "scan" | "empty";

export interface TextAssessment {
  quality: TextQuality;
  pages: number;
  /** Characters excluding the `[Page N]` markers extractPdfText inserts. */
  chars: number;
  charsPerPage: number;
}

/**
 * Decide whether an extraction actually yielded readable text.
 *
 * This exists because a scanned PDF does not fail — it succeeds and returns
 * only the page markers. A caller that treats that as "no content" will happily
 * hand an empty document to a model, which is exactly when a model invents one.
 *
 * Thresholds come from surveying the Parliament of Ghana repository: pages with
 * a real text layer averaged ~1,366 characters, while image-only scans produced
 * none at all. 40 chars/page sits far below any genuine page of legislation and
 * far above the zero a scan yields, so the classification is not sensitive to
 * where exactly in that gap the line falls.
 */
export function assessExtractedText(text: string): TextAssessment {
  const pages = (text.match(/\[Page \d+\]/g) ?? []).length;
  const chars = text.replace(/\[Page \d+\]/g, "").trim().length;
  const charsPerPage = pages > 0 ? Math.round(chars / pages) : chars;
  if (chars === 0) return { quality: pages > 0 ? "scan" : "empty", pages, chars, charsPerPage };
  return {
    quality: charsPerPage >= 40 ? "text" : "scan",
    pages,
    chars,
    charsPerPage,
  };
}
