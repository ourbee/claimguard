import { NextRequest, NextResponse } from "next/server";
import { extractDocument, UserFacingError, MAX_FILE_BYTES } from "@/lib/extract";
import { SYSTEM_PROMPT, wrapDocument } from "@/lib/prompt";
import { candidateModels, invalidateModelCache } from "@/lib/models";
import { selectPolicyExcerpts, trimHeadTail } from "@/lib/select";
import { checkRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

const SLOTS = ["policy", "bill", "letter"] as const;
type SlotKey = (typeof SLOTS)[number];

const SLOT_LABELS: Record<SlotKey, string> = {
  policy: "POLICY WORDING",
  bill: "HOSPITAL BILL / SETTLEMENT BREAKUP",
  letter: "INSURER LETTER / EMAIL",
};

const MAX_FILES_PER_SLOT = 4;
const MAX_IMAGES_TOTAL = 6;

// Character budgets keep one analysis inside Groq's free-tier limit of
// 8,000 tokens per minute (docs + system prompt + the model's reply).
const BUDGETS: Record<SlotKey, number> = { policy: 9000, bill: 5000, letter: 4000 };
const MAX_COMPLETION_TOKENS = 2600;

// ---------- response shape ----------

export interface Finding {
  verdict: "UNJUSTIFIED" | "JUSTIFIED" | "UNCLEAR";
  description: string;
  amount: number | null;
  policyBasis: string;
  note: string;
}

export interface AuditResult {
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

// ---------- helpers ----------

function friendly(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function asString(v: unknown, max = 8000): string {
  return typeof v === "string" ? v.slice(0, max).trim() : "";
}

function asAmount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.abs(v);
  if (typeof v === "string") {
    // Find the first number in the string, tolerating "Rs. 20,000.50" etc.
    const m = v.match(/\d[\d,]*(?:\.\d+)?/);
    if (m) {
      const n = parseFloat(m[0].replace(/,/g, ""));
      if (Number.isFinite(n)) return Math.abs(n);
    }
  }
  return null;
}

/**
 * Pulls the JSON object out of a model reply, tolerating reasoning preambles,
 * code fences, and trailing commentary.
 */
function parseModelJson(content: string): Omit<AuditResult, "totalUnjustified" | "docNotes"> | null {
  let text = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  text = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let raw: any;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const findings: Finding[] = (Array.isArray(raw.findings) ? raw.findings : [])
    .slice(0, 30)
    .map((f: any): Finding => {
      const v = asString(f?.verdict, 20).toUpperCase();
      return {
        verdict: v === "UNJUSTIFIED" || v === "JUSTIFIED" ? v : "UNCLEAR",
        description: asString(f?.description, 300) || "Deduction",
        amount: asAmount(f?.amount),
        policyBasis: asString(f?.policyBasis, 1500),
        note: asString(f?.note, 600),
      };
    });

  const summary = asString(raw.summary);
  if (!summary && findings.length === 0) return null;

  return {
    summary,
    findings,
    arithmeticCheck: asString(raw.arithmeticCheck),
    regulatoryNotes: asString(raw.regulatoryNotes),
    emailSubject: asString(raw.emailSubject, 300),
    emailBody: asString(raw.emailBody, 12000),
    caveats: asString(raw.caveats),
  };
}

interface GroqOutcome {
  ok: boolean;
  status: number;
  content?: string;
  errorCode?: string;
  errorMessage?: string;
}

async function callGroq(
  apiKey: string,
  model: string,
  messages: any[]
): Promise<GroqOutcome> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: MAX_COMPLETION_TOKENS,
      response_format: { type: "json_object" },
      messages,
    }),
    signal: AbortSignal.timeout(55_000),
  });

  if (!res.ok) {
    let code = "";
    let message = "";
    try {
      const body = await res.json();
      code = String(body?.error?.code || "");
      message = String(body?.error?.message || "");
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, status: res.status, errorCode: code, errorMessage: message };
  }

  const data = await res.json();
  return { ok: true, status: 200, content: data?.choices?.[0]?.message?.content || "" };
}

// ---------- route ----------

export async function POST(req: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return friendly("Server is missing GROQ_API_KEY. See DEPLOY.md.", 500);
  }

  // Block other websites from quietly using this API from their frontend.
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.get("host")) {
        return friendly("Requests from other websites are not allowed.", 403);
      }
    } catch {
      return friendly("Requests from other websites are not allowed.", 403);
    }
  }

  const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const rate = checkRateLimit(ip);
  if (!rate.allowed) return friendly(rate.message!, 429);

  try {
    const form = await req.formData();

    const docNotes: string[] = [];
    const textBySlot: Partial<Record<SlotKey, { name: string; text: string }>> = {};
    const imageDataUrls: string[] = [];
    const imageSlotNames: string[] = [];

    for (const slot of SLOTS) {
      const entries = form.getAll(slot).filter((e): e is File => e instanceof File);
      if (entries.length > MAX_FILES_PER_SLOT) {
        return friendly(`Please upload at most ${MAX_FILES_PER_SLOT} files per document.`, 400);
      }
      const texts: string[] = [];
      let firstName = "";
      for (const file of entries) {
        if (file.size === 0) continue;
        if (file.size > MAX_FILE_BYTES) {
          return friendly(`"${file.name}" is larger than 4 MB. Please compress it and try again.`, 400);
        }
        const extracted = await extractDocument(file);
        if (extracted.kind === "text") {
          texts.push(extracted.text);
          firstName = firstName || file.name;
        } else {
          if (imageDataUrls.length >= MAX_IMAGES_TOTAL) {
            return friendly(`Please upload at most ${MAX_IMAGES_TOTAL} photos in total.`, 400);
          }
          imageDataUrls.push(extracted.dataUrl);
          imageSlotNames.push(`${SLOT_LABELS[slot]} — ${file.name}`);
        }
      }
      if (texts.length > 0) {
        textBySlot[slot] = { name: firstName, text: texts.join("\n\n") };
      }
    }

    const useVision = imageDataUrls.length > 0;
    if (!useVision && Object.keys(textBySlot).length === 0) {
      return friendly("Please upload at least one document before analyzing.", 400);
    }

    // --- assemble the user message within token budget ---
    const scale = useVision ? 0.6 : 1; // photos cost tokens too
    const parts: string[] = [];

    const referenceText = [textBySlot.bill?.text || "", textBySlot.letter?.text || ""].join("\n");

    for (const slot of SLOTS) {
      const doc = textBySlot[slot];
      if (!doc) continue;
      const budget = Math.floor(BUDGETS[slot] * scale);
      const sel =
        slot === "policy"
          ? selectPolicyExcerpts(doc.text, referenceText, budget)
          : trimHeadTail(doc.text, budget);
      if (sel.trimmed) {
        docNotes.push(
          slot === "policy"
            ? "Your policy wording was long, so ClaimGuard sent the AI only the sections most relevant to your deductions (exclusions, limits, co-pay, room rent and similar clauses)."
            : `Your ${slot === "bill" ? "bill" : "insurer letter"} was long and was trimmed to fit the free AI tier (start and end kept).`
        );
      }
      parts.push(
        wrapDocument(
          slot === "policy" && sel.trimmed
            ? `${SLOT_LABELS[slot]} (relevant excerpts)`
            : SLOT_LABELS[slot],
          doc.name,
          sel.text
        )
      );
    }

    for (const label of imageSlotNames) {
      parts.push(`[Photo attached below: ${label}]`);
    }

    const facts: string[] = [];
    const sumInsured = String(form.get("sumInsured") || "").replace(/[^\d]/g, "").slice(0, 12);
    const bonus = String(form.get("bonus") || "").replace(/[^\d]/g, "").slice(0, 12);
    if (sumInsured) facts.push(`Sum insured stated by user: Rs. ${sumInsured}`);
    if (bonus) facts.push(`Accrued/cumulative bonus stated by user: Rs. ${bonus}`);
    if (facts.length) parts.unshift(`USER-PROVIDED FACTS:\n${facts.join("\n")}`);

    const combinedText = parts.join("\n\n");

    const userContent: any = useVision
      ? [
          { type: "text", text: combinedText },
          ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
        ]
      : combinedText;

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];

    // --- call Groq, falling back through candidate models ---
    const models = await candidateModels(useVision ? "vision" : "text", apiKey);
    let outcome: GroqOutcome | null = null;

    for (const model of models.slice(0, 3)) {
      outcome = await callGroq(apiKey, model, messages);
      if (outcome.ok) break;
      const modelGone =
        outcome.errorCode === "model_decommissioned" ||
        outcome.errorCode === "model_not_found" ||
        /decommission|does not exist|not found/i.test(outcome.errorMessage || "");
      if (modelGone) {
        invalidateModelCache();
        continue; // try the next model on the list
      }
      break; // a different error — don't burn quota retrying
    }

    if (!outcome || !outcome.ok) {
      const status = outcome?.status ?? 0;
      // Log only status/code — never document contents.
      console.error(`analyze: groq error status=${status} code=${outcome?.errorCode || "?"}`);
      if (status === 429) {
        const daily = /day|daily|TPD|RPD/i.test(outcome?.errorMessage || "");
        return friendly(
          daily
            ? "Today's free analysis capacity has been used up. Please come back tomorrow — nothing you uploaded was stored."
            : "The AI service is busy right now. Please wait a minute and try again.",
          429
        );
      }
      if (status === 413 || /too large|request entity/i.test(outcome?.errorMessage || "")) {
        return friendly(
          "Your documents are too long for the free AI tier even after trimming. Try uploading only the pages that show the deductions.",
          413
        );
      }
      if (status === 401) {
        return friendly("The server's AI key is invalid or expired. (Site owner: check GROQ_API_KEY in Vercel.)", 500);
      }
      return friendly(
        "The AI models this app relies on appear to be unavailable or retired. (Site owner: see MAINTENANCE.md to update model names — a two-minute fix.)",
        502
      );
    }

    const parsed = parseModelJson(outcome.content || "");
    if (!parsed) {
      console.error("analyze: model reply was not parseable JSON");
      return friendly("The AI returned an unreadable response. Please try again — this is usually temporary.", 502);
    }

    // The one number users act on is computed here, in plain arithmetic —
    // never trusted from the model.
    const totalUnjustified = parsed.findings
      .filter((f) => f.verdict === "UNJUSTIFIED" && f.amount !== null)
      .reduce((sum, f) => sum + (f.amount as number), 0);

    const result: AuditResult = { totalUnjustified, ...parsed, docNotes };
    return NextResponse.json({ result });
  } catch (err: any) {
    if (err instanceof UserFacingError) {
      return friendly(err.message, 400);
    }
    // Log the error type only — never contents.
    console.error(`analyze: unexpected ${err?.name || "error"}`);
    return friendly("Something went wrong while analyzing your documents. Please try again.", 500);
  }
}
