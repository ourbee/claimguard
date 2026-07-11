# Deploying ClaimGuard — step by step

You don't need to write or edit any code for this. Just follow these steps in order.

## Step 1 — Get the two free AI keys

**Gemini (the main engine — big free allowance):**

1. Go to **https://aistudio.google.com/apikey** and sign in with a Google account.
2. Click **Create API key** and copy it.

**Groq (the automatic backup):**

1. Go to **https://console.groq.com**
2. Sign up (Google sign-in is fastest).
3. On the left sidebar, click **API Keys**.
4. Click **Create API Key**, name it "claimguard", and click **Submit**.
5. Copy the key that appears (it starts with `gsk_...`). **Save it somewhere** — you won't be able to see it again.

## Step 2 — Put the code on GitHub

1. Go to **https://github.com** and sign up if you don't have an account.
2. Click the **+** icon top-right → **New repository**.
3. Name it `claimguard`. Keep it **Public**. Don't tick "add a README" (we already have one). Click **Create repository**.
4. On the next page, click **uploading an existing file**.
5. Drag the **entire contents** of the claimguard folder (not the folder itself) into the upload box. Skip the `node_modules` and `.next` folders if they exist — they are build junk and GitHub doesn't need them.
6. Scroll down, click **Commit changes**.

## Step 3 — Deploy to Vercel (free hosting)

1. Go to **https://vercel.com** and sign up using **"Continue with GitHub"** (this links the two automatically).
2. Click **Add New** → **Project**.
3. Find your `claimguard` repo in the list and click **Import**.
4. Before clicking deploy, expand **Environment Variables** and add both keys:
   - Name: `GEMINI_API_KEY` — Value: *the Gemini key from Step 1*
   - Name: `GROQ_API_KEY` — Value: *the Groq key from Step 1*
5. Click **Deploy**. Wait about a minute.
6. Vercel will give you a live URL like `claimguard-xyz.vercel.app` — that's your public app. Share it with anyone.

## Making changes later

Tell me what you want changed, I'll hand you updated files, and you repeat Step 2 (upload the new files to the same GitHub repo, overwriting the old ones) — Vercel automatically redeploys within a minute.

If Groq ever retires its AI models, see **MAINTENANCE.md** — that's a two-minute fix in the Vercel dashboard, no code involved.

## Capacity, honestly

- With both free keys, the app handles roughly **200+ analyses per day** (Gemini's
  free daily quota, with Groq's ~25–35 as backup). When both are used up, users see
  a polite "come back tomorrow" message. You can never be billed by surprise — the
  free tiers just stop.
- If the tool becomes popular: either service offers pay-as-you-go (Groq:
  console.groq.com → Billing, about **₹0.20–0.30 per analysis**). No code changes needed.
- Each visitor is limited to 3 analyses per minute / 15 per day, and uploads are capped
  at ~4 MB total, so one person can't drain the daily quota by scripting.

## Privacy, honestly

- Nothing is stored: no database, no file storage, no user accounts. Documents are
  processed in memory during the request and discarded.
- Document text IS sent to the AI service (Google Gemini or Groq) for analysis.
  Both state that API data is not used to train models (for Gemini's free tier,
  Google may review samples for abuse/safety — avoid uploading documents with
  Aadhaar or bank numbers, or black them out first). The app's footer says this plainly.
- Server logs never contain document contents — only error codes.

## What this app does NOT do

- It is not legal advice; every report says so and points to IRDAI's Bima Bharosa
  portal and the Insurance Ombudsman for escalation.
- It reads PDFs with a real text layer, DOCX, TXT, and photos (JPG/PNG/WebP).
  A **scanned PDF** (no text layer — common for hospital bills) is automatically
  converted to page images **in the user's own browser** so the AI can read it —
  nothing extra is sent anywhere. A password-protected PDF gets instructions for
  making an unlocked copy.
- Because the free AI tier reads a limited amount at once, very long policies are
  auto-trimmed to the relevant clauses and at most 5 scanned/photo pages are read
  per analysis. The report tells the user whenever this happens.
