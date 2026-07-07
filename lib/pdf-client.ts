// Runs ONLY in the browser. Decides whether a PDF has a real text layer
// (send as-is, cheap) or is a scan (render its pages to images so the vision
// model can read them). This is what lets scanned hospital bills work without
// asking the user to photograph every page — and it stays private, because
// the rendering happens on their own device, not on any server.

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";

// Point pdf.js at its worker. Next/webpack bundles this to a same-origin URL,
// so there's no external request (keeps the app private and offline-capable).
if (typeof window !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.min.js",
    import.meta.url
  ).toString();
}

export const MAX_PDF_PAGES_RENDERED = 5; // Groq accepts at most 5 images/request
const RENDER_MAX_EDGE = 1100; // long-edge pixels — balances legibility vs. tokens

export type PdfResult =
  | { kind: "text-pdf" } // has a usable text layer; send the original file
  | { kind: "images"; files: File[]; pageCount: number; truncated: boolean }; // scanned

export class PdfClientError extends Error {}

async function renderPageToJpeg(page: any, baseName: string, index: number): Promise<File> {
  const viewport = page.getViewport({ scale: 1 });
  const scale = Math.min(1, RENDER_MAX_EDGE / Math.max(viewport.width, viewport.height));
  const scaled = page.getViewport({ scale: scale * 2 }); // 2× for OCR-legibility, then JPEG-compressed
  const finalScale = Math.min(1, RENDER_MAX_EDGE / Math.max(scaled.width, scaled.height));
  const v = page.getViewport({ scale: Math.max(finalScale, scale) });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(v.width);
  canvas.height = Math.round(v.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new PdfClientError("Your browser could not render the PDF pages.");
  // White background so transparent PDFs don't render black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: v }).promise;

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.72));
  if (!blob) throw new PdfClientError("Your browser could not convert the PDF pages to images.");
  return new File([blob], `${baseName}-page-${index + 1}.jpg`, { type: "image/jpeg" });
}

/**
 * Inspect a PDF. If it has real selectable text, returns { kind: "text-pdf" }
 * and the caller should upload the original file. If it's a scan, renders the
 * pages to JPEG images and returns them.
 */
export async function processPdf(file: File): Promise<PdfResult> {
  const data = new Uint8Array(await file.arrayBuffer());
  let doc: any;
  try {
    doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  } catch (err: any) {
    const msg = String(err?.name || err?.message || "");
    if (/Password/i.test(msg)) {
      throw new PdfClientError(
        `"${file.name}" is password-protected. Open it on your device with the password, ` +
          `use Print → "Save as PDF" to make an unlocked copy, and upload that instead.`
      );
    }
    // Not a readable PDF at all — let the server give its own message.
    return { kind: "text-pdf" };
  }

  // Sample the text layer across pages.
  let totalChars = 0;
  const sampleUpTo = Math.min(doc.numPages, 10);
  for (let i = 1; i <= sampleUpTo; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    totalChars += content.items.reduce((n: number, it: any) => n + (it.str?.length || 0), 0);
    if (totalChars > 400) break; // clearly has a text layer; stop early
  }

  if (totalChars > 400) {
    return { kind: "text-pdf" };
  }

  // Scanned: render pages to images.
  const baseName = file.name.replace(/\.pdf$/i, "");
  const pagesToRender = Math.min(doc.numPages, MAX_PDF_PAGES_RENDERED);
  const files: File[] = [];
  for (let i = 0; i < pagesToRender; i++) {
    const page = await doc.getPage(i + 1);
    files.push(await renderPageToJpeg(page, baseName, i));
  }
  return {
    kind: "images",
    files,
    pageCount: doc.numPages,
    truncated: doc.numPages > pagesToRender,
  };
}
