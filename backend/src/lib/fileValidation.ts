import JSZip from "jszip";

export type SupportedDocumentType = "pdf" | "docx" | "doc";

export type DocumentValidationResult =
  | { ok: true }
  | { ok: false; detail: string };

const MAX_DOCX_ENTRIES = 10_000;
const MAX_DOCX_EXPANDED_BYTES = 512 * 1024 * 1024;

function hasPrefix(buffer: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => buffer[index] === value);
}

function invalid(type: string): DocumentValidationResult {
  return {
    ok: false,
    detail: `File content does not match the .${type} extension.`,
  };
}

/**
 * Validate the file's actual container signature before it reaches storage,
 * parsers, or LibreOffice. This is intentionally independent of the
 * client-supplied MIME type and filename beyond the already-allowlisted suffix.
 */
export async function validateDocumentFile(
  buffer: Buffer,
  type: string,
): Promise<DocumentValidationResult> {
  if (buffer.length === 0) return invalid(type);

  if (type === "pdf") {
    // ISO 32000 permits the header to appear within the first 1024 bytes.
    return buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))
      ? { ok: true }
      : invalid(type);
  }

  if (type === "doc") {
    const isOle = hasPrefix(buffer, [
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    ]);
    // Word also accepts Rich Text Format documents saved with a .doc suffix.
    const isRtf = buffer.subarray(0, 16).toString("ascii").startsWith("{\\rtf");
    return isOle || isRtf ? { ok: true } : invalid(type);
  }

  if (type !== "docx") return invalid(type);

  if (!hasPrefix(buffer, [0x50, 0x4b])) return invalid(type);
  try {
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
    const entries = Object.values(zip.files);
    if (entries.length > MAX_DOCX_ENTRIES) {
      return { ok: false, detail: "DOCX archive contains too many entries." };
    }

    // JSZip obtains these sizes from the central directory without inflating
    // every entry. The cap rejects obvious archive bombs before conversion.
    let expandedBytes = 0;
    for (const entry of entries) {
      const data = (entry as unknown as {
        _data?: { uncompressedSize?: number };
      })._data;
      const size = data?.uncompressedSize;
      if (typeof size === "number" && Number.isFinite(size) && size >= 0) {
        expandedBytes += size;
        if (expandedBytes > MAX_DOCX_EXPANDED_BYTES) {
          return {
            ok: false,
            detail: "DOCX archive expands beyond the permitted size.",
          };
        }
      }
    }

    if (!zip.file("[Content_Types].xml") || !zip.file("word/document.xml")) {
      return invalid(type);
    }
    return { ok: true };
  } catch {
    return invalid(type);
  }
}
