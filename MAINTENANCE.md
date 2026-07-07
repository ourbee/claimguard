# Keeping ClaimGuard alive — the only maintenance it ever needs

ClaimGuard depends on exactly one outside service: **Groq** (the free AI). Groq retires
old models every few months. ClaimGuard is built to survive this **automatically** —
it checks Groq's live model list on every analysis and uses the best model that still
exists from its built-in preference list.

You only need to act if **all** the built-in models have been retired. You'll know
because the app will show users this message:

> "The AI models this app relies on appear to be unavailable or retired.
> (Site owner: see MAINTENANCE.md to update model names — a two-minute fix.)"

## The two-minute fix (no code, no coding tools)

1. Find the current model names: open **https://console.groq.com/docs/models** and note
   - a large **text** model marked "Production" (in mid-2026 this is `openai/gpt-oss-120b`)
   - a **vision** model (one that accepts images; in mid-2026 this is `qwen/qwen3.6-27b`)
2. Go to **https://vercel.com** → your `claimguard` project → **Settings** →
   **Environment Variables**.
3. Add (or edit) these two variables:
   - `TEXT_MODEL` = the text model name from step 1
   - `VISION_MODEL` = the vision model name from step 1
4. Go to the **Deployments** tab → click the "⋯" menu on the latest deployment →
   **Redeploy**. Done — the app uses your values immediately, ahead of its built-in list.

## Other things you might one day want

- **The app says "Today's free analysis capacity has been used up"** — the free Groq
  key has hit its daily token quota (~25–35 analyses/day). If this happens often, log
  into console.groq.com → Billing and enable pay-as-you-go. Cost is roughly ₹0.20–0.30
  per analysis; nothing in the app needs to change.
- **Replacing the Groq key** (if it leaks or you regenerate it): Vercel → Settings →
  Environment Variables → edit `GROQ_API_KEY` → Redeploy.
- **Changing the Buy-me-a-coffee link**: it's the `COFFEE_URL` constant near the top of
  `app/page.tsx` — edit the file on GitHub in the browser, commit, and Vercel redeploys
  automatically.
