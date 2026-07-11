# Keeping ClaimGuard alive — the only maintenance it ever needs

ClaimGuard uses two free AI services, in this order:

1. **Google Gemini** (if `GEMINI_API_KEY` is set) — big free allowance, so even long
   policy wordings are read in full.
2. **Groq** (`GROQ_API_KEY`) — small free allowance, used as the automatic backup.

Every analysis automatically tries Gemini first, then Groq, and within each service
tries several current models from a built-in preference list (checked against the
service's live model list). One service being down, out of quota, or retiring a model
does **not** break the app — the analysis just flows to the next option. Users only
see an error when *everything* fails at once.

## Set up the Gemini key (do this once — it's the main engine)

1. Go to **https://aistudio.google.com/apikey** and sign in with any Google account.
2. Click **Create API key**. Copy it.
3. Go to **https://vercel.com** → your `claimguard` project → **Settings** →
   **Environment Variables** → add `GEMINI_API_KEY` = the key you copied.
4. **Deployments** tab → "⋯" menu on the latest deployment → **Redeploy**. Done.

Without this key the app still works on Groq alone, but long policy wordings get
trimmed much harder and daily capacity is lower.

## If the app ever says the AI models were retired

This now only appears when the model names on *both* services are genuinely gone.
The two-minute fix, no code involved:

1. Find current model names:
   - Gemini: open **https://ai.google.dev/gemini-api/docs/models** and note the
     current "Flash" model (e.g. `gemini-2.5-flash`).
   - Groq: open **https://console.groq.com/docs/models** and note a large
     **text** model marked "Production" and a **vision** model (accepts images).
2. Vercel → `claimguard` project → **Settings** → **Environment Variables**, set:
   - `GEMINI_MODEL` = the Gemini flash model name
   - `TEXT_MODEL` = the Groq text model name
   - `VISION_MODEL` = the Groq vision model name
3. **Deployments** tab → "⋯" → **Redeploy**. The app uses your values immediately,
   ahead of its built-in list.

## Other things you might one day want

- **"Today's free analysis capacity has been used up"** — both services hit their
  daily free quota. With the Gemini key set this allows roughly 200+ analyses/day;
  Groq alone is ~25–35/day. If it happens often, either service offers pay-as-you-go
  (Groq: console.groq.com → Billing, ~₹0.20–0.30 per analysis).
- **Replacing a key** (leaked or regenerated): Vercel → Settings → Environment
  Variables → edit `GEMINI_API_KEY` or `GROQ_API_KEY` → Redeploy.
- **Changing the Buy-me-a-coffee link**: it's the `COFFEE_URL` constant near the top
  of `app/page.tsx` — edit the file on GitHub in the browser, commit, and Vercel
  redeploys automatically.
