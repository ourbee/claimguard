// Best-effort, in-memory, per-IP rate limiting. No database (the app's privacy
// promise), so counters live in the warm serverless instance. That's imperfect
// — a cold start resets them — but it stops casual scripting and accidental
// hammering, which is the realistic threat for a free tool.

interface Bucket {
  minuteStart: number;
  minuteCount: number;
  dayStart: number;
  dayCount: number;
}

const buckets = new Map<string, Bucket>();

const PER_MINUTE = 3;
const PER_DAY = 15;

export interface RateResult {
  allowed: boolean;
  message?: string;
}

export function checkRateLimit(ip: string): RateResult {
  const now = Date.now();

  // Keep the map from growing unbounded on a long-lived instance.
  if (buckets.size > 5000) {
    for (const [key, b] of buckets) {
      if (now - b.dayStart > 24 * 3600 * 1000) buckets.delete(key);
    }
  }

  let b = buckets.get(ip);
  if (!b) {
    b = { minuteStart: now, minuteCount: 0, dayStart: now, dayCount: 0 };
    buckets.set(ip, b);
  }

  if (now - b.minuteStart > 60_000) {
    b.minuteStart = now;
    b.minuteCount = 0;
  }
  if (now - b.dayStart > 24 * 3600 * 1000) {
    b.dayStart = now;
    b.dayCount = 0;
  }

  if (b.dayCount >= PER_DAY) {
    return {
      allowed: false,
      message:
        "You've reached today's limit for this free tool. Please come back tomorrow — your documents were not stored.",
    };
  }
  if (b.minuteCount >= PER_MINUTE) {
    return {
      allowed: false,
      message: "Please wait a minute before running another analysis.",
    };
  }

  b.minuteCount++;
  b.dayCount++;
  return { allowed: true };
}
