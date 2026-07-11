// Keeps the prompt inside the active AI provider's free-tier token budget
// (generous on Gemini, tight on Groq — see lib/models.ts) by sending only the
// parts of each document that matter.
//
// Policy wordings run 30–100 pages, but a claims audit only needs the clauses
// related to what was actually deducted. So: split the policy into chunks,
// score each chunk against (a) a standing list of deduction-related insurance
// terms and (b) the actual words appearing in the bill/letter, then keep the
// best-scoring chunks up to a character budget. Everything runs locally in
// memory — no extra API, nothing leaves the server.

const STANDING_TERMS = [
  "exclusion", "exclusions", "excluded",
  "co-pay", "copay", "co-payment", "copayment",
  "deduct", "deduction", "deductible", "disallow",
  "room rent", "room category", "icu", "intensive care",
  "sub-limit", "sublimit", "limit of", "capped", "capping",
  "proportionate", "reasonable and customary", "customary",
  "non-payable", "non payable", "consumable", "consumables",
  "cumulative bonus", "no claim bonus", "sum insured",
  "waiting period", "pre-existing",
  "cataract", "maternity", "ambulance", "day care", "domiciliary",
  "ayush", "modern treatment",
  "claim", "settlement", "cashless", "reimbursement", "grievance",
];

const STOPWORDS = new Set([
  "shall", "will", "would", "could", "should", "their", "there", "these",
  "those", "which", "where", "under", "above", "being", "other", "after",
  "before", "during", "between", "against", "amount", "total", "rupees",
  "hospital", "insured", "policy", "company", "insurer", "patient",
]);

/** Words from the bill/letter worth searching the policy for. */
function queryTerms(referenceText: string): string[] {
  const counts = new Map<string, number>();
  for (const raw of referenceText.toLowerCase().split(/[^a-z]+/)) {
    if (raw.length < 5 || STOPWORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80)
    .map(([w]) => w);
}

function chunkText(text: string, maxChunk = 1200): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length > maxChunk) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
    // A single huge paragraph gets split hard.
    while (current.length > maxChunk * 1.6) {
      chunks.push(current.slice(0, maxChunk));
      current = current.slice(maxChunk);
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1 && count < 20) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

export interface Selection {
  text: string;
  trimmed: boolean;
}

/**
 * Returns the policy text if it fits the budget, otherwise the most relevant
 * excerpts (in original document order, separated by "[...]").
 */
export function selectPolicyExcerpts(
  policyText: string,
  billAndLetterText: string,
  budgetChars: number
): Selection {
  if (policyText.length <= budgetChars) {
    return { text: policyText, trimmed: false };
  }

  const chunks = chunkText(policyText);
  const terms = queryTerms(billAndLetterText);

  const scored = chunks.map((chunk, index) => {
    const lower = chunk.toLowerCase();
    let score = 0;
    for (const term of STANDING_TERMS) score += countOccurrences(lower, term) * 3;
    for (const term of terms) score += countOccurrences(lower, term);
    // The schedule of benefits / policy summary usually sits up front.
    if (index < 2) score += 25;
    return { chunk, index, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const picked: { chunk: string; index: number }[] = [];
  let used = 0;
  for (const s of scored) {
    if (used + s.chunk.length > budgetChars) continue;
    picked.push(s);
    used += s.chunk.length;
    if (used > budgetChars * 0.95) break;
  }

  picked.sort((a, b) => a.index - b.index);
  return { text: picked.map((p) => p.chunk).join("\n[...]\n"), trimmed: true };
}

/**
 * Trims a bill/letter to budget keeping the head and the tail — bills put
 * their totals and deduction summaries at the end.
 */
export function trimHeadTail(text: string, budgetChars: number): Selection {
  if (text.length <= budgetChars) return { text, trimmed: false };
  const head = Math.floor(budgetChars * 0.65);
  const tail = budgetChars - head;
  return {
    text: `${text.slice(0, head)}\n[... middle of document omitted ...]\n${text.slice(-tail)}`,
    trimmed: true,
  };
}
