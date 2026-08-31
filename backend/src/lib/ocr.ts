// OCR for scanned PDFs, using the multimodal model behind CUSTOM_LLM_BASE_URL.
//
// About a third of the Ghana legislation corpus is image-only: extraction
// succeeds and returns nothing but page markers. Rather than reporting those
// Acts as permanently unreadable, pages are rasterised with poppler's pdftoppm
// and transcribed by the vision model.
//
// OCR text is NOT the same as an extracted text layer and must never be
// presented as though it were. It is a model's reading of an image: mostly
// excellent on these scans, but capable of dropping a "not", mangling a figure,
// or smoothing over a smudge — any of which changes what a provision means.
// Callers surface it as quality "ocr" and say so; see ghanaLaw.ts.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { completeCustomVision, type UserApiKeys } from "./llm";

/** Rasterisation resolution. 150dpi reads cleanly and keeps payloads ~50-100KB. */
const OCR_DPI = Number(process.env.OCR_DPI ?? "150");

/**
 * Pages transcribed in one request. OCR costs roughly ten seconds a page, so an
 * uncapped 200-page Act would block for half an hour. Callers page through.
 */
export const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES ?? "12");

/** Pages transcribed in parallel. Kept small — the endpoint is shared. */
const OCR_CONCURRENCY = Math.max(
  1,
  Number(process.env.OCR_CONCURRENCY ?? "4"),
);

const RASTERISE_TIMEOUT_MS = Number(
  process.env.OCR_RASTERISE_TIMEOUT_MS ?? "120000",
);

const OCR_INSTRUCTION =
  "Transcribe this page of legislation to plain text, verbatim. Preserve " +
  "section numbers, headings, subsection markers and list letters exactly as " +
  "printed. Do not summarise, correct, modernise or comment. If part of the " +
  "page is illegible, write [illegible] in that position rather than guessing. " +
  "Output only the transcription.";

function executablePath(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let _binary: string | null | undefined;

/**
 * Locate pdftoppm (poppler-utils), mirroring how convert.ts finds soffice:
 * an env override first, then PATH, then the usual install locations.
 */
export function resolvePdftoppmPath(): string | null {
  if (_binary !== undefined) return _binary;
  const candidates: string[] = [];
  const override = process.env.PDFTOPPM_BINARY_PATH?.trim();
  if (override) candidates.push(override);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, "pdftoppm"), path.join(dir, "pdftoppm.exe"));
  }
  candidates.push("/usr/bin/pdftoppm", "/usr/local/bin/pdftoppm");
  _binary = candidates.find(executablePath) ?? null;
  return _binary;
}

/** Test seam — clears the memoised binary lookup. */
export function resetOcrBinaryCache(): void {
  _binary = undefined;
}

export function ocrAvailable(): boolean {
  return (process.env.OCR_ENABLED ?? "true").toLowerCase() !== "false" &&
    resolvePdftoppmPath() !== null;
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("pdftoppm timed out"));
    }, RASTERISE_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`pdftoppm exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

/**
 * Render a page range to PNGs. Returns base64 strings in page order, paired
 * with their 1-based page number.
 */
export async function rasterisePdfPages(
  pdf: ArrayBuffer,
  opts: { firstPage: number; lastPage: number },
): Promise<{ page: number; base64: string }[]> {
  const bin = resolvePdftoppmPath();
  if (!bin) throw new Error("pdftoppm is not installed");

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mike-ocr-"));
  const src = path.join(dir, "in.pdf");
  try {
    await fs.promises.writeFile(src, Buffer.from(pdf));
    await run(bin, [
      "-png",
      "-r",
      String(OCR_DPI),
      "-f",
      String(opts.firstPage),
      "-l",
      String(opts.lastPage),
      src,
      path.join(dir, "page"),
    ]);
    const files = (await fs.promises.readdir(dir))
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort();
    const out: { page: number; base64: string }[] = [];
    for (const file of files) {
      // pdftoppm names output page-<n>.png, numbered by source page.
      const n = Number.parseInt(file.replace(/^page-?/, ""), 10);
      const buf = await fs.promises.readFile(path.join(dir, file));
      out.push({
        page: Number.isFinite(n) ? n : out.length + opts.firstPage,
        base64: buf.toString("base64"),
      });
    }
    return out.sort((a, b) => a.page - b.page);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface OcrResult {
  /** Transcribed text, in the same `[Page N]` block shape as extractPdfText. */
  text: string;
  pagesRead: number;
  firstPage: number;
  lastPage: number;
  /** True when the document has more pages than were transcribed. */
  truncated: boolean;
}

/**
 * Transcribe a page range of a scanned PDF.
 *
 * Pages are sent one per request: a page is roughly 50-100KB of base64, and
 * batching them into one prompt both risks the context limit and makes a single
 * failure lose the whole range. A page that fails is marked in place rather
 * than aborting the run, so a partial transcription is still usable.
 */
export async function ocrPdfPages(params: {
  pdf: ArrayBuffer;
  model: string;
  totalPages: number;
  firstPage?: number;
  maxPages?: number;
  apiKeys?: UserApiKeys;
}): Promise<OcrResult> {
  const firstPage = Math.max(1, params.firstPage ?? 1);
  const maxPages = Math.max(1, Math.min(params.maxPages ?? OCR_MAX_PAGES, OCR_MAX_PAGES));
  const lastPage = Math.min(params.totalPages, firstPage + maxPages - 1);

  const images = await rasterisePdfPages(params.pdf, { firstPage, lastPage });

  // Pages are transcribed a few at a time. Sequentially, a page takes ~14s, so
  // a 20-page range would block a chat turn for five minutes; a small pool cuts
  // that to a usable wait without flooding a shared endpoint.
  const blocks: string[] = new Array(images.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= images.length) return;
      const img = images[i];
      let text: string;
      try {
        text = await completeCustomVision({
          model: params.model,
          instruction: OCR_INSTRUCTION,
          imageBase64: img.base64,
          apiKeys: params.apiKeys,
        });
      } catch (err) {
        // One bad page must not lose the rest of the transcription; mark it in
        // place so the gap is visible rather than silently closed up.
        text = `[transcription failed: ${
          err instanceof Error ? err.message : "unknown error"
        }]`;
      }
      blocks[i] = `[Page ${img.page}]\n${text.trim()}`;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(OCR_CONCURRENCY, images.length) }, worker),
  );

  return {
    text: blocks.join("\n\n"),
    pagesRead: images.length,
    firstPage,
    lastPage,
    truncated: lastPage < params.totalPages,
  };
}
