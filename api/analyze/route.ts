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

const MAX_FILES_PER_SLOT = 6;
const MAX_IMAGES_TOTAL = 5; // Groq accepts at most 5 images per request

// --- token budget (Groq free tier is 8,000 tokens/minute for the durable
// text model; input tokens + the reserved reply both count against it) ---
const TPM_CEILING = 8000;
const REPLY_TOKENS = 1500; // reserved for the model's JSON answer
const SAFETY_MARGIN = 600;
const CHARS_PER_TOKEN = 3.5; // rough English/PDF estimate
const IMAGE_TOKENS = 1250; // conservative estimate per attached image

const estTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);
const SYSTEM_TOKENS = estTokens(SYSTEM_PROMPT);

// Priority weights for splitting the text budget across present documents.
const DOC_WEIGHT: Record<SlotKey, number> = { policy: 0.5, bill: 0.28, letter: 0.22 };

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
    const m = v.match(/\d[\d,]*(?:\.\d+)?/);
    if (m) {
      const n = parseFloat(m[0].replace(/,/g, ""));
      if (Number.isFinite(n)) return Math.abs(n);
    }
  }
  return null;
}

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

async function callGroq(apiKey: string, model: string, messages: any[]): Promise<GroqOutcome> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: REPLY_TOKENS,
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

interface TextDoc {
  slot: SlotKey;
  name: string;
  text: string;
}

/**
 * Assembles the user message within a token budget scaled by `squeeze`
 * (1 = full budget, smaller = tighter, used when a first attempt is rejected
 * for being too large). Trims long text and, when very tight, drops trailing
 * images. Returns the message plus notes about what had to be shortened.
 */
function buildUserMessage(
  textDocs: TextDoc[],
  imageDataUrls: string[],
  facts: string[],
  squeeze: number
) {
  const notes: string[] = [];
  const inputBudget = Math.floor((TPM_CEILING - REPLY_TOKENS - SAFETY_MARGIN) * squeeze);
  let remainingTokens = inputBudget - SYSTEM_TOKENS - estTokens(facts.join("\n"));

  // Fit as many images as the token budget allows, but reserve some room for
  // policy text when text docs are present (so the model can still match
  // clauses). Deriving the cap from the budget means the first attempt fits
  // by construction, instead of wasting a round-trip on a rejection.
  const hasText = textDocs.some((d) => d.text.trim().length > 0);
  const reserveForText = hasText ? 1400 : 0;
  const imageTokenBudget = Math.max(IMAGE_TOKENS, remainingTokens - reserveForText);
  let maxImages = Math.floor(imageTokenBudget / IMAGE_TOKENS);
  maxImages = Math.min(maxImages, MAX_IMAGES_TOTAL, imageDataUrls.length);
  if (imageDataUrls.length > 0) maxImages = Math.max(1, maxImages);

  const usedImages = imageDataUrls.slice(0, maxImages);
  if (usedImages.length < imageDataUrls.length) {
    notes.push(
      `Only ${usedImages.length} of ${imageDataUrls.length} images fit the free AI tier this time. Uploading the pages that show the deductions first gives the best result.`
    );
  }
  remainingTokens -= usedImages.length * IMAGE_TOKENS;

  // Split the remaining text budget across present docs by priority.
  const present = textDocs.filter((d) => d.text.trim().length > 0);
  const weightSum = present.reduce((s, d) => s + DOC_WEIGHT[d.slot], 0) || 1;
  const referenceText = textDocs
    .filter((d) => d.slot !== "policy")
    .map((d) => d.text)
    .join("\n");

  const textBudgetChars = Math.max(0, remainingTokens) * CHARS_PER_TOKEN;
  const parts: string[] = [];

  for (const doc of present) {
    const share = Math.floor((textBudgetChars * DOC_WEIGHT[doc.slot]) / weightSum);
    const sel =
      doc.slot === "policy"
        ? selectPolicyExcerpts(doc.text, referenceText, share)
        : trimHeadTail(doc.text, share);
    if (sel.trimmed) {
      notes.push(
        doc.slot === "policy"
          ? "Your policy wording was long, so ClaimGuard sent the AI only the clauses most relevant to your deductions (exclusions, limits, co-pay, room rent)."
          : `Your ${doc.slot === "bill" ? "bill" : "insurer letter"} was long and was trimmed to fit the free AI tier.`
      );
    }
    parts.push(
      wrapDocument(
        doc.slot === "policy" && sel.trimmed ? `${SLOT_LABELS[doc.slot]} (relevant excerpts)` : SLOT_LABELS[doc.slot],
        doc.name,
        sel.text
      )
    );
  }

  for (let i = 0; i < usedImages.length; i++) {
    parts.push(`[Photo/scan page attached below, #${i + 1}]`);
  }
  if (facts.length) parts.unshift(`USER-PROVIDED FACTS:\n${facts.join("\n")}`);

  const combinedText = parts.join("\n\n");
  const content: any =
    usedImages.length > 0
      ? [{ type: "text", text: combinedText }, ...usedImages.map((url) => ({ type: "image_url", image_url: { url } }))]
      : combinedText;

  return { content, notes, usedImageCount: usedImages.length };
}

// ---------- route ----------

export async function POST(req: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return friendly("Server is missing GROQ_API_KEY. See DEPLOY.md.", 500);

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

    const textDocs: TextDoc[] = [];
    const imageDataUrls: string[] = [];

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
          if (imageDataUrls.length < MAX_IMAGES_TOTAL) imageDataUrls.push(extracted.dataUrl);
        }
      }
      if (texts.length > 0) textDocs.push({ slot, name: firstName, text: texts.join("\n\n") });
    }

    if (textDocs.length === 0 && imageDataUrls.length === 0) {
      return friendly("Please upload at least one document before analyzing.", 400);
    }

    const useVision = imageDataUrls.length > 0;

    const facts: string[] = [];
    const sumInsured = String(form.get("sumInsured") || "").replace(/[^\d]/g, "").slice(0, 12);
    const bonus = String(form.get("bonus") || "").replace(/[^\d]/g, "").slice(0, 12);
    if (sumInsured) facts.push(`Sum insured stated by user: Rs. ${sumInsured}`);
    if (bonus) facts.push(`Accrued/cumulative bonus stated by user: Rs. ${bonus}`);

    const models = await candidateModels(useVision ? "vision" : "text", apiKey);

    // Try each model; for each, shrink the payload and retry if Groq says it's
    // too big — so the user gets an answer instead of a "too long" error.
    const squeezes = [1, 0.65, 0.45];
    let outcome: GroqOutcome | null = null;
    let notes: string[] = [];

    outer: for (const model of models.slice(0, 3)) {
      for (const squeeze of squeezes) {
        const built = buildUserMessage(textDocs, imageDataUrls, facts, squeeze);
        notes = built.notes;
        const messages = [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: built.content },
        ];
        outcome = await callGroq(apiKey, model, messages);

        if (outcome.ok) break outer;

        const msg = outcome.errorMessage || "";
        const modelGone =
          outcome.errorCode === "model_decommissioned" ||
          outcome.errorCode === "model_not_found" ||
          /decommission|does not exist|not found/i.test(msg);
        if (modelGone) {
          invalidateModelCache();
          continue outer; // next model, restart from full size
        }

        const tooBig = outcome.status === 413 || /too large|request entity|reduce/i.test(msg);
        const tpmHit = outcome.status === 429 && /token|per minute|tpm/i.test(msg) && !/day|daily|tpd|rpd|requests per/i.test(msg);
        if (tooBig || tpmHit) {
          continue; // shrink and retry
        }
        break outer; // a different error — stop
      }
    }

    if (!outcome || !outcome.ok) {
      const status = outcome?.status ?? 0;
      console.error(`analyze: groq error status=${status} code=${outcome?.errorCode || "?"}`);
      const msg = outcome?.errorMessage || "";
      if (status === 429) {
        const daily = /day|daily|tpd|rpd|requests per/i.test(msg);
        return friendly(
          daily
            ? "Today's free analysis capacity has been used up. Please come back tomorrow — nothing you uploaded was stored."
            : "The AI service is busy right now. Please wait a minute and try again.",
          429
        );
      }
      if (status === 413 || /too large|request entity/i.test(msg)) {
        return friendly(
          "Even after trimming, your documents are too large for the free AI tier. Try uploading just the policy pages with the relevant clauses and the bill pages showing the deductions.",
          413
        );
      }
      if (status === 401) {
        return friendly("The server's AI key is invalid or expired. (Site owner: check GROQ_API_KEY in Vercel.)", 500);
      }
      return friendly(
        "The AI models this app relies on appear to be unavailable or retired. (Site owner: see MAINTENANCE.md — a two-minute fix.)",
        502
      );
    }

    const parsed = parseModelJson(outcome.content || "");
    if (!parsed) {
      console.error("analyze: model reply was not parseable JSON");
      return friendly("The AI returned an unreadable response. Please try again — this is usually temporary.", 502);
    }

    const totalUnjustified = parsed.findings
      .filter((f) => f.verdict === "UNJUSTIFIED" && f.amount !== null)
      .reduce((sum, f) => sum + (f.amount as number), 0);

    const result: AuditResult = { totalUnjustified, ...parsed, docNotes: notes };
    return NextResponse.json({ result });
  } catch (err: any) {
    if (err instanceof UserFacingError) return friendly(err.message, 400);
    console.error(`analyze: unexpected ${err?.name || "error"}`);
    return friendly("Something went wrong while analyzing your documents. Please try again.", 500);
  }
}
