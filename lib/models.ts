// Provider + model selection with automatic fallback.
//
// ClaimGuard can talk to two free AI providers through the same
// OpenAI-compatible API shape:
//
//   1. Google Gemini — the free tier has a large budget (~250,000 tokens per
//      minute and a 1M-token context window), so full policy wordings usually
//      fit without trimming. Used first whenever GEMINI_API_KEY is set.
//   2. Groq — the free tier is small (8,000 tokens per minute), so documents
//      get trimmed hard. Used when Gemini is not configured or fails.
//
// Providers retire models from time to time. Each provider has a ranked
// preference list; at request time we fetch the provider's live model list
// (cached for 10 minutes) and try only preferences that still exist. Gemini's
// "-latest" aliases track new releases automatically, so that list should
// survive years without edits. If the model list can't be fetched, we fall
// back to the raw preferences and let the completion call surface any error.
//
// MANUAL OVERRIDE (no code changes needed): set GEMINI_MODEL (Gemini) or
// TEXT_MODEL / VISION_MODEL (Groq) as environment variables in Vercel. They
// are always tried first. See MAINTENANCE.md.

export interface Provider {
  name: "gemini" | "groq";
  baseUrl: string;
  apiKey: string;
  /** Net token budget for the request input (prompt + documents + images). */
  inputTokenBudget: number;
  /** Tokens reserved for the model's reply (including hidden reasoning). */
  replyTokens: number;
}

// Overridable so the endpoints can be repointed (or mocked in tests) via env.
const GEMINI_BASE =
  process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai";
const GROQ_BASE = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";

// Gemini Flash models are multimodal, so text and vision share one list.
const GEMINI_PREFERENCES = [
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
];

const GROQ_TEXT_PREFERENCES = [
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
];

const GROQ_VISION_PREFERENCES = [
  "qwen/qwen3.6-27b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
];

// Groq free tier: 8,000 tokens/minute shared between input and the reserved
// reply. gpt-oss models spend part of the reply on hidden reasoning, so the
// reply reservation must be roomy or the JSON answer gets cut off mid-object
// (Groq then rejects it with json_validate_failed).
const GROQ_REPLY_TOKENS = 2500;
const GROQ_INPUT_BUDGET = 8000 - GROQ_REPLY_TOKENS - 600 /* safety margin */;

// Gemini free tier: ~250k tokens/minute. Cap input well below that so a
// single request can never trip the per-minute limit on its own.
const GEMINI_REPLY_TOKENS = 8192;
const GEMINI_INPUT_BUDGET = 120_000;

/** Providers to try, in order. Gemini first when configured (bigger budget). */
export function activeProviders(): Provider[] {
  const providers: Provider[] = [];
  const geminiKey = (process.env.GEMINI_API_KEY || "").trim();
  const groqKey = (process.env.GROQ_API_KEY || "").trim();
  if (geminiKey) {
    providers.push({
      name: "gemini",
      baseUrl: GEMINI_BASE,
      apiKey: geminiKey,
      inputTokenBudget: GEMINI_INPUT_BUDGET,
      replyTokens: GEMINI_REPLY_TOKENS,
    });
  }
  if (groqKey) {
    providers.push({
      name: "groq",
      baseUrl: GROQ_BASE,
      apiKey: groqKey,
      inputTokenBudget: GROQ_INPUT_BUDGET,
      replyTokens: GROQ_REPLY_TOKENS,
    });
  }
  return providers;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const modelCache = new Map<string, { ids: Set<string>; at: number }>();

async function fetchAvailableModelIds(provider: Provider): Promise<Set<string> | null> {
  const now = Date.now();
  const cached = modelCache.get(provider.name);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.ids;
  try {
    const res = await fetch(`${provider.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ids = new Set<string>(
      (Array.isArray(data?.data) ? data.data : [])
        // Gemini lists ids as "models/gemini-2.5-flash"; normalize that away.
        .map((m: any) => String(m?.id || "").replace(/^models\//, ""))
        .filter(Boolean)
    );
    if (ids.size === 0) return null;
    modelCache.set(provider.name, { ids, at: now });
    return ids;
  } catch {
    return null;
  }
}

export function invalidateModelCache(providerName?: string) {
  if (providerName) modelCache.delete(providerName);
  else modelCache.clear();
}

function preferenceList(provider: Provider, kind: "text" | "vision"): string[] {
  let envOverride: string | undefined;
  let defaults: string[];
  if (provider.name === "gemini") {
    envOverride = process.env.GEMINI_MODEL;
    defaults = GEMINI_PREFERENCES;
  } else {
    envOverride = kind === "vision" ? process.env.VISION_MODEL : process.env.TEXT_MODEL;
    defaults = kind === "vision" ? GROQ_VISION_PREFERENCES : GROQ_TEXT_PREFERENCES;
  }
  const list = envOverride ? [envOverride.trim(), ...defaults] : [...defaults];
  // De-duplicate while keeping order.
  return list.filter((m, i) => m && list.indexOf(m) === i);
}

/**
 * Returns the ranked candidate models to try on this provider. The first
 * entry is the best guess; later entries are fallbacks if the provider
 * rejects the model (e.g. freshly decommissioned and our cache was stale).
 */
export async function candidateModels(
  provider: Provider,
  kind: "text" | "vision"
): Promise<string[]> {
  const prefs = preferenceList(provider, kind);
  const available = await fetchAvailableModelIds(provider);
  if (!available) return prefs;
  const alive = prefs.filter((m) => available.has(m));
  // If nothing on our list is available (all retired), fall back to the raw
  // preference order so the error message the user sees is at least accurate.
  return alive.length > 0 ? alive : prefs;
}
