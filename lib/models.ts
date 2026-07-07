// Model selection with automatic fallback.
//
// Groq retires models from time to time. Instead of hardcoding one model name,
// we keep a ranked preference list and, at request time, ask Groq which models
// are actually available right now (cached for 10 minutes). The first available
// preference wins. If Groq's model list can't be fetched, we fall back to the
// top preference and let the completion call surface any error.
//
// MANUAL OVERRIDE (no code changes needed): set TEXT_MODEL and/or VISION_MODEL
// as environment variables in Vercel. They are always tried first.
// See MAINTENANCE.md.

const TEXT_PREFERENCES = [
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
];

const VISION_PREFERENCES = [
  "qwen/qwen3.6-27b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
];

const MODELS_URL = "https://api.groq.com/openai/v1/models";
const CACHE_TTL_MS = 10 * 60 * 1000;

let cachedIds: Set<string> | null = null;
let cachedAt = 0;

async function fetchAvailableModelIds(apiKey: string): Promise<Set<string> | null> {
  const now = Date.now();
  if (cachedIds && now - cachedAt < CACHE_TTL_MS) return cachedIds;
  try {
    const res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ids = new Set<string>(
      (Array.isArray(data?.data) ? data.data : [])
        .map((m: any) => String(m?.id || ""))
        .filter(Boolean)
    );
    if (ids.size === 0) return null;
    cachedIds = ids;
    cachedAt = now;
    return ids;
  } catch {
    return null;
  }
}

export function invalidateModelCache() {
  cachedIds = null;
  cachedAt = 0;
}

function preferenceList(kind: "text" | "vision"): string[] {
  const envOverride =
    kind === "vision" ? process.env.VISION_MODEL : process.env.TEXT_MODEL;
  const defaults = kind === "vision" ? VISION_PREFERENCES : TEXT_PREFERENCES;
  const list = envOverride ? [envOverride.trim(), ...defaults] : [...defaults];
  // De-duplicate while keeping order.
  return list.filter((m, i) => m && list.indexOf(m) === i);
}

/**
 * Returns the ranked candidate models to try for this request. The first
 * entry is the best guess; later entries are fallbacks if Groq rejects the
 * model (e.g. freshly decommissioned and our cache was stale).
 */
export async function candidateModels(
  kind: "text" | "vision",
  apiKey: string
): Promise<string[]> {
  const prefs = preferenceList(kind);
  const available = await fetchAvailableModelIds(apiKey);
  if (!available) return prefs;
  const alive = prefs.filter((m) => available.has(m));
  // If nothing on our list is available (all retired), fall back to the raw
  // preference order so the error message the user sees is at least accurate.
  return alive.length > 0 ? alive : prefs;
}
