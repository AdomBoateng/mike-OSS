import assert from "node:assert/strict";
import { describe, test } from "node:test";
import JSZip from "jszip";
import { validateDocumentFile } from "./fileValidation";

describe("validateDocumentFile", () => {
  test("accepts a PDF header within the first 1024 bytes", async () => {
    const result = await validateDocumentFile(
      Buffer.from("comment\n%PDF-1.7\nbody"),
      "pdf",
    );
    assert.equal(result.ok, true);
  });

  test("rejects extension-only PDF spoofing", async () => {
    const result = await validateDocumentFile(Buffer.from("<html>bad</html>"), "pdf");
    assert.equal(result.ok, false);
  });

  test("accepts OLE and RTF Word documents", async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    assert.equal((await validateDocumentFile(ole, "doc")).ok, true);
    assert.equal(
      (await validateDocumentFile(Buffer.from("{\\rtf1 test}"), "doc")).ok,
      true,
    );
  });

  test("requires a real DOCX package", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<w:document/>");
    const valid = await zip.generateAsync({ type: "nodebuffer" });
    assert.equal((await validateDocumentFile(valid, "docx")).ok, true);

    const genericZip = new JSZip();
    genericZip.file("payload.txt", "not a Word document");
    const invalid = await genericZip.generateAsync({ type: "nodebuffer" });
    assert.equal((await validateDocumentFile(invalid, "docx")).ok, false);
  });
});
