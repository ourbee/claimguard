"use client";

import { useEffect, useRef, useState } from "react";
// lib/pdf-client pulls in pdf.js (~120 kB); it's loaded on demand at submit
// time only when a PDF is present, to keep the initial page light on mobile.

type SlotKey = "policy" | "bill" | "letter";

interface Finding {
  verdict: "UNJUSTIFIED" | "JUSTIFIED" | "UNCLEAR";
  description: string;
  amount: number | null;
  policyBasis: string;
  note: string;
}

interface AuditResult {
  totalUnjustified: number;
  summary: string;
  findings: Finding[];
  arithmeticCheck: string;
  regulatoryNotes: string;
  emailSubject: string;
  emailBody: string;
  caveats: string;
  docNotes: string[];
}

const SLOTS: { key: SlotKey; no: string; label: string; hint: string }[] = [
  {
    key: "policy",
    no: "01",
    label: "Policy wording",
    hint: "The terms & conditions document from your insurer. PDF, DOCX, TXT, or photos.",
  },
  {
    key: "bill",
    no: "02",
    label: "Hospital bill / settlement breakup",
    hint: "The itemised bill or settlement sheet showing what was deducted. Photos of multiple pages are fine.",
  },
  {
    key: "letter",
    no: "03",
    label: "Insurer letter or email",
    hint: "The denial, partial-settlement, or deduction-explanation communication.",
  },
];

const MAX_FILES_PER_SLOT = 4;
const MAX_FILE_MB = 4;
const MAX_TOTAL_MB = 4.2;
const COFFEE_URL = "https://www.buymeacoffee.com/ritwikbalo";

function formatINR(n: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

/** Downscale photos client-side: faster uploads, fewer AI tokens, same legibility. */
async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.8));
    bitmap.close();
    if (!blob) return file;
    if (blob.size >= file.size && /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file; // let the server give a precise message if it can't be read
  }
}

function buildReportText(r: AuditResult): string {
  const lines: string[] = [];
  lines.push("CLAIMGUARD — CLAIM AUDIT REPORT");
  lines.push(`Generated: ${new Date().toLocaleDateString("en-IN")}`);
  lines.push("");
  lines.push(`TOTAL UNJUSTIFIED DEDUCTIONS: ${formatINR(r.totalUnjustified)}`);
  lines.push("(Total computed by ClaimGuard from the individual line items below.)");
  lines.push("");
  lines.push("=== SUMMARY ===");
  lines.push(r.summary);
  for (const f of r.findings) {
    lines.push("");
    lines.push(`[${f.verdict}] ${f.description}${f.amount !== null ? ` — ${formatINR(f.amount)}` : ""}`);
    if (f.policyBasis) lines.push(`Policy basis: ${f.policyBasis}`);
    if (f.note) lines.push(`Note: ${f.note}`);
  }
  lines.push("");
  lines.push("=== ARITHMETIC CHECK ===");
  lines.push(r.arithmeticCheck || "—");
  lines.push("");
  lines.push("=== REGULATORY NOTES ===");
  lines.push(r.regulatoryNotes || "—");
  lines.push("");
  lines.push("=== DRAFT ESCALATION EMAIL ===");
  lines.push(`Subject: ${r.emailSubject}`);
  lines.push("");
  lines.push(r.emailBody);
  lines.push("");
  lines.push("=== CAVEATS ===");
  lines.push(r.caveats || "—");
  lines.push("");
  lines.push(
    "ClaimGuard gives analytical support, not legal advice. If your insurer does not resolve the issue, escalate via IRDAI's Bima Bharosa portal (bimabharosa.irdai.gov.in) or the Insurance Ombudsman (cioins.co.in)."
  );
  return lines.join("\n");
}

const MAX_IMAGES_TOTAL = 5; // Groq accepts at most 5 images per request

const STAGES: { at: number; label: string }[] = [
  { at: 0, label: "Preparing your documents…" },
  { at: 30, label: "Uploading securely…" },
  { at: 40, label: "Reading your documents…" },
  { at: 55, label: "Selecting the policy clauses that matter…" },
  { at: 68, label: "Auditing every deduction against your policy…" },
  { at: 88, label: "Drafting your escalation email…" },
];

export default function Home() {
  const [files, setFiles] = useState<Record<SlotKey, File[]>>({ policy: [], bill: [], letter: [] });
  const [sumInsured, setSumInsured] = useState("");
  const [bonus, setBonus] = useState("");
  const [working, setWorking] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [prepNotes, setPrepNotes] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => stopTimer(), []);

  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  const stageLabel = STAGES.reduce((acc, s) => (pct >= s.at ? s.label : acc), STAGES[0].label);

  // Takes a plain File[] — never a live FileList. The input gets reset right
  // after selection, and a live FileList empties itself when that happens,
  // so it must be copied into an array before this state update runs.
  function addFiles(slot: SlotKey, list: File[]) {
    if (list.length === 0) return;
    setError(null);
    setFiles((prev) => {
      const next = [...prev[slot]];
      for (const f of list) {
        if (next.length >= MAX_FILES_PER_SLOT) break;
        if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
        next.push(f);
      }
      return { ...prev, [slot]: next };
    });
  }

  function removeFile(slot: SlotKey, index: number) {
    setFiles((prev) => ({ ...prev, [slot]: prev[slot].filter((_, i) => i !== index) }));
  }

  async function handleSubmit() {
    setError(null);
    setResult(null);
    setPrepNotes([]);

    const hasAny = SLOTS.some((s) => files[s.key].length > 0);
    if (!hasAny) {
      setError("Upload at least one document to begin — the policy wording gives the strongest results.");
      return;
    }

    setWorking(true);
    setPct(2);

    try {
      // --- Prepare each file in the browser (private, no server, no extra API):
      // text PDFs go up as-is; scanned PDFs get their pages rendered to images
      // so the vision model can read them; photos get downscaled. This is what
      // makes scanned hospital bills "just work" without asking for photos. ---
      const prepared: { slot: SlotKey; file: File }[] = [];
      const pNotes: string[] = [];
      let imageCount = 0;
      let hitImageCap = false;

      const queue = SLOTS.flatMap((s) => files[s.key].map((file) => ({ slot: s.key, file })));
      let done = 0;

      // Load pdf.js only if there's actually a PDF to process.
      const hasPdf = queue.some(({ file }) => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
      const pdfMod = hasPdf ? await import("@/lib/pdf-client") : null;

      const noteImageCapOnce = () => {
        if (!hitImageCap) {
          hitImageCap = true;
          pNotes.push(
            `The free AI tier reads at most ${MAX_IMAGES_TOTAL} images per analysis. Extra scanned/photo pages were left out — upload the pages showing the deductions first.`
          );
        }
      };

      for (const { slot, file } of queue) {
        const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);

        if (isPdf && pdfMod) {
          let res;
          try {
            res = await pdfMod.processPdf(file);
          } catch (e) {
            if (e instanceof pdfMod.PdfClientError) throw new UserError(e.message);
            res = { kind: "text-pdf" as const };
          }
          if (res.kind === "text-pdf") {
            prepared.push({ slot, file });
          } else {
            for (const img of res.files) {
              if (imageCount >= MAX_IMAGES_TOTAL) {
                noteImageCapOnce();
                break;
              }
              prepared.push({ slot, file: img });
              imageCount++;
            }
            pNotes.push(
              `"${file.name}" is a scanned PDF, so ClaimGuard converted ${
                res.truncated
                  ? `its first ${pdfMod.MAX_PDF_PAGES_RENDERED} pages`
                  : `its ${res.files.length} page${res.files.length > 1 ? "s" : ""}`
              } to images for the AI to read.`
            );
          }
        } else if (file.type.startsWith("image/")) {
          if (imageCount >= MAX_IMAGES_TOTAL) {
            noteImageCapOnce();
          } else {
            prepared.push({ slot, file: await compressImage(file) });
            imageCount++;
          }
        } else {
          prepared.push({ slot, file });
        }

        done++;
        setPct(2 + Math.round((done / queue.length) * 26)); // prep occupies 2–28%
      }

      if (prepared.length === 0) {
        throw new UserError("None of your files could be read. Please try different files (PDF, DOCX, TXT, JPG, or PNG).");
      }

      const form = new FormData();
      let totalBytes = 0;
      for (const { slot, file } of prepared) {
        if (file.size > MAX_FILE_MB * 1024 * 1024) {
          throw new UserError(`"${file.name}" is larger than ${MAX_FILE_MB} MB. Please compress it or split it up.`);
        }
        totalBytes += file.size;
        form.append(slot, file, file.name);
      }
      if (totalBytes > MAX_TOTAL_MB * 1024 * 1024) {
        throw new UserError(
          "Your files together exceed the 4 MB upload limit. Try uploading only the pages that show the deductions."
        );
      }
      if (sumInsured.trim()) form.append("sumInsured", sumInsured.trim());
      if (bonus.trim()) form.append("bonus", bonus.trim());
      setPrepNotes(pNotes);

      // After upload completes, advance the bar through estimated stages —
      // the AI step's duration can't be measured mid-flight.
      const { status, body } = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/analyze");
        xhr.timeout = 90_000;
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setPct(30 + Math.round((e.loaded / e.total) * 8));
        };
        xhr.upload.onload = () => {
          setPct(40);
          stopTimer();
          timerRef.current = setInterval(() => {
            setPct((p) => (p < 68 ? p + 1.4 : p + Math.max(0.05, (94 - p) * 0.02)));
          }, 300);
        };
        xhr.onload = () => {
          let parsed: any = null;
          try {
            parsed = JSON.parse(xhr.responseText);
          } catch {
            /* non-JSON (e.g. host-level 413) */
          }
          resolve({ status: xhr.status, body: parsed });
        };
        xhr.onerror = () => reject(new Error("network"));
        xhr.ontimeout = () => reject(new Error("timeout"));
        xhr.send(form);
      });

      stopTimer();

      if (status === 200 && body?.result) {
        setPct(100);
        setResult(body.result as AuditResult);
        setTimeout(() => reportRef.current?.focus(), 100);
      } else if (body?.error) {
        setError(body.error);
      } else if (status === 413) {
        setError("Your files together are too large (over ~4.5 MB). Try uploading only the pages that show the deductions.");
      } else {
        setError("Something went wrong on the server. Please try again in a minute.");
      }
    } catch (e: any) {
      stopTimer();
      if (e instanceof UserError) setError(e.message);
      else if (e?.message === "timeout") setError("The analysis took too long and timed out. Please try again — smaller or fewer documents help.");
      else setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setWorking(false);
      setPct(0);
    }
  }

  async function copyText(kind: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 2000);
    } catch {
      setError("Couldn't copy — your browser blocked clipboard access. Select the text manually instead.");
    }
  }

  function downloadReport() {
    if (!result) return;
    const blob = new Blob([buildReportText(result)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ClaimGuard-report.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function openGmail() {
    if (!result) return;
    const url = `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(
      result.emailSubject
    )}&body=${encodeURIComponent(result.emailBody)}`;
    window.open(url, "_blank", "noopener");
  }

  function openMailApp() {
    if (!result) return;
    window.location.href = `mailto:?subject=${encodeURIComponent(result.emailSubject)}&body=${encodeURIComponent(
      result.emailBody
    )}`;
  }

  function shareWhatsApp() {
    if (!result) return;
    const top = result.findings
      .filter((f) => f.verdict === "UNJUSTIFIED")
      .slice(0, 3)
      .map((f) => `• ${f.description}${f.amount !== null ? ` — ${formatINR(f.amount)}` : ""}`)
      .join("\n");
    const text =
      `ClaimGuard audited my health-insurance claim: ${formatINR(result.totalUnjustified)} of deductions ` +
      `have no basis in my policy wording.\n${top ? `\n${top}\n` : ""}\n(Report generated by ClaimGuard)`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text.slice(0, 1500))}`, "_blank", "noopener");
  }

  return (
    <main className="shell">
      <div className="masthead">
        <h1>
          Claim<span>Guard</span>
        </h1>
        <div className="file-no">CASE FILE — NEW ENTRY</div>
      </div>

      <p className="tagline">
        Upload your policy wording, hospital bill, and insurer&apos;s letter. ClaimGuard checks every
        deduction against your actual policy terms, flags what your insurer can&apos;t justify, and
        drafts the email you send back.
      </p>

      <div className="dossier no-print">
        {SLOTS.map((slot) => (
          <div className="slot" key={slot.key}>
            <div className="slot-no">{slot.no}</div>
            <div className="slot-body">
              <p className="slot-label" id={`label-${slot.key}`}>
                {slot.label}
              </p>
              <p className="slot-hint">{slot.hint}</p>

              {files[slot.key].length > 0 && (
                <ul className="file-chips" aria-label={`Files added for ${slot.label}`}>
                  {files[slot.key].map((f, i) => (
                    <li key={`${f.name}-${i}`} className="file-chip">
                      <span className="file-chip-name">{f.name}</span>
                      <button
                        type="button"
                        className="file-chip-remove"
                        aria-label={`Remove ${f.name}`}
                        onClick={() => removeFile(slot.key, i)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {files[slot.key].length < MAX_FILES_PER_SLOT && (
                <label className={`dropzone ${files[slot.key].length ? "has-file" : ""}`} htmlFor={`file-${slot.key}`}>
                  <span className="dropzone-text">
                    {files[slot.key].length
                      ? "Add another page or file"
                      : "No file selected"}
                  </span>
                  <span className="pick-btn">Choose file</span>
                  <input
                    id={`file-${slot.key}`}
                    className="visually-hidden-input"
                    type="file"
                    multiple
                    accept=".pdf,.docx,.txt,image/jpeg,image/png,image/webp,image/heic"
                    aria-labelledby={`label-${slot.key}`}
                    onChange={(e) => {
                      addFiles(slot.key, Array.from(e.target.files || []));
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
            </div>
          </div>
        ))}

        <div className="slot">
          <div className="slot-no">+</div>
          <div className="slot-body">
            <p className="slot-label">Optional details</p>
            <p className="slot-hint">
              These help verify room-rent caps and sub-limits, which are usually percentages of your sum insured.
            </p>
            <div className="details-row">
              <label className="detail-field">
                <span>Sum insured (₹)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="e.g. 500000"
                  value={sumInsured}
                  onChange={(e) => setSumInsured(e.target.value.replace(/[^\d]/g, "").slice(0, 12))}
                />
              </label>
              <label className="detail-field">
                <span>Accrued bonus (₹)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="e.g. 100000"
                  value={bonus}
                  onChange={(e) => setBonus(e.target.value.replace(/[^\d]/g, "").slice(0, 12))}
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="submit-row no-print">
        <button className="stamp-btn" onClick={handleSubmit} disabled={working}>
          {working ? "Analyzing…" : "Analyze my claim"}
        </button>
        <span className="submit-note">
          Processed in memory and analyzed by a free AI service (Google Gemini or Groq) — never stored, by us or anyone.
        </span>
      </div>

      <div aria-live="polite" className="no-print">
        {error && (
          <p className="error-note" role="alert">
            {error}
          </p>
        )}
        {working && (
          <div className="progress-wrap">
            <div
              className="progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              aria-label="Analysis progress"
            >
              <div className="progress-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
            </div>
            <div className="progress-meta">
              <span className="progress-label">{stageLabel}</span>
              <span className="progress-pct">{Math.round(Math.min(pct, 100))}%</span>
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="report" ref={reportRef} tabIndex={-1} aria-label="Audit report">
          <div className="report-total">
            <span className="label">
              Total unjustified deductions found
              <span className="label-sub">Computed from the line items below — not by the AI</span>
            </span>
            <span className="amount">{formatINR(result.totalUnjustified)}</span>
          </div>

          {(prepNotes.length > 0 || result.docNotes.length > 0) && (
            <div className="doc-notes">
              {[...prepNotes, ...result.docNotes].map((n, i) => (
                <p key={i}>ⓘ {n}</p>
              ))}
            </div>
          )}

          <section className="report-section">
            <h3>Summary</h3>
            <div className="report-body">{result.summary}</div>
          </section>

          {result.findings.length > 0 && (
            <section className="report-section">
              <h3>Line-by-line findings</h3>
              <div className="findings">
                {result.findings.map((f, i) => (
                  <div className="finding-card" key={i}>
                    <div className="finding-head">
                      <span
                        className={`verdict ${
                          f.verdict === "UNJUSTIFIED" ? "unjustified" : f.verdict === "JUSTIFIED" ? "justified" : "unclear"
                        }`}
                      >
                        {f.verdict === "UNJUSTIFIED" ? "Unjustified" : f.verdict === "JUSTIFIED" ? "Justified" : "Needs review"}
                      </span>
                      <span className="finding-desc">{f.description}</span>
                      {f.amount !== null && <span className="finding-amount">{formatINR(f.amount)}</span>}
                    </div>
                    {f.policyBasis && (
                      <div className="finding-basis">
                        <span className="basis-label">Policy basis</span>
                        {f.policyBasis}
                      </div>
                    )}
                    {f.note && <div className="finding-note">{f.note}</div>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {result.arithmeticCheck && (
            <section className="report-section">
              <h3>Arithmetic check</h3>
              <div className="report-body">{result.arithmeticCheck}</div>
            </section>
          )}

          {result.regulatoryNotes && (
            <section className="report-section">
              <h3>Regulatory notes</h3>
              <div className="report-body">{result.regulatoryNotes}</div>
            </section>
          )}

          {result.emailBody && (
            <section className="report-section">
              <h3>Draft escalation email</h3>
              <div className="email-block">
                <div className="email-subject">Subject: {result.emailSubject}</div>
                <div className="report-body">{result.emailBody}</div>
              </div>
              <div className="copy-row no-print">
                <button className="copy-btn" onClick={() => copyText("email", `Subject: ${result.emailSubject}\n\n${result.emailBody}`)}>
                  {copied === "email" ? "Copied ✓" : "Copy email"}
                </button>
                <button className="copy-btn" onClick={openGmail}>
                  Open in Gmail
                </button>
                <button className="copy-btn" onClick={openMailApp}>
                  Open in email app
                </button>
              </div>
            </section>
          )}

          {result.caveats && (
            <section className="report-section">
              <h3>Important caveats</h3>
              <div className="report-body">{result.caveats}</div>
            </section>
          )}

          <section className="report-section">
            <h3>If your insurer doesn&apos;t respond</h3>
            <div className="report-body">
              Escalate free of cost via IRDAI&apos;s{" "}
              <a href="https://bimabharosa.irdai.gov.in/" target="_blank" rel="noopener noreferrer">
                Bima Bharosa grievance portal
              </a>{" "}
              or the{" "}
              <a href="https://www.cioins.co.in/" target="_blank" rel="noopener noreferrer">
                Insurance Ombudsman
              </a>{" "}
              — both accept complaints online.
            </div>
          </section>

          <div className="copy-row no-print">
            <button className="copy-btn" onClick={downloadReport}>
              Download report
            </button>
            <button className="copy-btn" onClick={() => window.print()}>
              Print / Save as PDF
            </button>
            <button className="copy-btn" onClick={() => copyText("report", buildReportText(result))}>
              {copied === "report" ? "Copied ✓" : "Copy full report"}
            </button>
            <button className="copy-btn" onClick={shareWhatsApp}>
              Share on WhatsApp
            </button>
          </div>
        </div>
      )}

      <footer>
        <p>
          ClaimGuard gives analytical support, not legal advice. Verify clause references against your own
          policy document before relying on them. Documents are processed in memory and sent to a free AI
          service (Google Gemini or Groq) for analysis — nothing is stored by this app. Free to use, with a daily analysis limit.
        </p>
        <p className="credit">
          Created by Ritwik Balo ·{" "}
          <a href={COFFEE_URL} target="_blank" rel="noopener noreferrer">
            ☕ Buy me a coffee
          </a>
        </p>
      </footer>
    </main>
  );
}

class UserError extends Error {}
