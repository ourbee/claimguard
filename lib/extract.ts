import mammoth from "mammoth";

// Result of extracting one uploaded document.
export type Extracted =
  | { kind: "text"; text: string }
  | { kind: "image"; dataUrl: string };

export const MAX_FILE_BYTES = 4.5 * 1024 * 1024; // matches Vercel's request body ceiling

/**
 * Turns an uploaded File into either extracted text (for PDFs with a text
 * layer, Word docs, and .txt) or a base64 image data URL (for photos/scans,
 * which go straight to the vision model). Everything happens in memory —
 * nothing is written to disk.
 */
export async function extractDocument(file: File): Promise<Extracted> {
  if (file.size > MAX_FILE_BYTES) {
    throw new UserFacingError(
      `"${file.name}" is larger than 4 MB. Please compress it or upload it in parts.`
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const type = file.type;
  const name = file.name.toLowerCase();

  if (type.startsWith("image/")) {
    if (!/^image\/(jpeg|png|webp)$/.test(type)) {
      throw new UserFacingError(
        `"${file.name}" is an image format the AI can't read. Please upload it as JPG or PNG.`
      );
    }
    return { kind: "image", dataUrl: `data:${type};base64,${buffer.toString("base64")}` };
  }

  if (type === "application/pdf" || name.endsWith(".pdf")) {
    // pdf-parse pulls text from PDFs that have a real text layer.
    // Dynamic import avoids bundling its debug entrypoint at build time.
    const pdfParse = (await import("pdf-parse")).default;
    let parsed;
    try {
      parsed = await pdfParse(buffer);
    } catch (err: any) {
      if (/password|encrypt/i.test(String(err?.message || err?.name || ""))) {
        throw new UserFacingError(
          `"${file.name}" is password-protected (insurers often lock policy PDFs with your PAN or date of birth). ` +
            `Open it on your device with the password, use Print → "Save as PDF" to make an unlocked copy, and upload that instead.`
        );
      }
      throw new UserFacingError(
        `"${file.name}" couldn't be read as a PDF. If it's a scan, upload clear photos of the pages (JPG/PNG) instead.`
      );
    }
    const text = (parsed.text || "").trim();

    if (text.length > 200) {
      return { kind: "text", text };
    }

    // Likely a scanned PDF with no text layer. We don't rasterize it
    // server-side — ask the user for photos instead.
    throw new UserFacingError(
      `"${file.name}" looks like a scanned PDF with no selectable text. Please upload clear photos or screenshots of the pages instead (JPG/PNG).`
    );
  }

  if (
    type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();
    if (text.length < 30) {
      throw new UserFacingError(
        `"${file.name}" appears to be empty or unreadable. Please check the file and try again.`
      );
    }
    return { kind: "text", text };
  }

  if (type === "text/plain" || name.endsWith(".txt")) {
    return { kind: "text", text: buffer.toString("utf-8") };
  }

  throw new UserFacingError(
    `"${file.name}" is a file type ClaimGuard doesn't support yet. Please upload a PDF, DOCX, TXT, JPG, or PNG.`
  );
}

/** An error whose message is safe and useful to show to the end user. */
export class UserFacingError extends Error {
  isUserFacing = true;
}
