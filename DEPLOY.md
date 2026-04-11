# AutoFilm — Deployment Guide

Follow these steps in order. Week 1 is all setup, no code changes.

---

## Step 1 — Push to GitHub (do this first)

```bash
# On your machine, in the autofilm/ folder
git init
git add .
git commit -m "Initial commit — AutoFilm v12"
git remote add origin https://github.com/carbizken/autofilm.git
git push -u origin main
```

---

## Step 2 — Deploy frontend to Vercel (~20 minutes)

1. Go to vercel.com → New Project → Import from GitHub → select `carbizken/autofilm`
2. Framework: **Other**
3. Root directory: leave blank (vercel.json handles routing)
4. Deploy

**Add custom domain:**
- Project Settings → Domains → Add `autofilm.io`
- Add `www.autofilm.io` → redirects to `autofilm.io`
- DNS: Add Vercel's A record at your registrar

**Live URLs after deploy:**
- `autofilm.io` → landing page
- `autofilm.io/app` → rep app
- `autofilm.io/player` → customer player
- `autofilm.io/command` → GM dashboard
- `autofilm.io/pitch` → pitch page

---

## Step 3 — Deploy Cloudflare Worker (~30 minutes)

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login
wrangler login

# Create KV namespace
wrangler kv:namespace create LINKS
# Copy the ID it gives you into wrangler.toml

# Add your account_id to wrangler.toml (find it at dash.cloudflare.com)

# Deploy
wrangler deploy

# Add custom domain in Cloudflare dashboard:
# Workers & Pages → autofilm-links → Settings → Domains
# Add: links.autofilm.io
```

---

## Step 4 — Create accounts and get API keys

### Mux (video hosting)
1. mux.com → Create account → Create new environment
2. Settings → Access Tokens → Generate Token
3. Save: `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET`

### Twilio (SMS)
1. twilio.com → Create account
2. Get a phone number: Console → Phone Numbers → Buy a Number
3. Save: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`

### Supabase (database + auth)
1. supabase.com → New project
2. Settings → API → copy URL and service_role key
3. SQL Editor → paste contents of `supabase/schema.sql` → Run
4. Save: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`

### Generate VAPID keys (Web Push notifications)
```bash
npx web-push generate-vapid-keys
# Copy both keys into .env
```

---

## Step 5 — Deploy backend API to Render (~30 minutes)

1. render.com → New → Web Service → Connect GitHub → select `carbizken/autofilm`
2. Root directory: `backend`
3. Build command: `npm install`
4. Start command: `npm start`
5. Instance type: **Starter** ($7/mo) for pilot, **Standard** ($25/mo) for production

**Add environment variables** (Settings → Environment):
Copy every variable from `backend/.env.example` and fill in real values.

**Add custom domain:**
- Settings → Custom Domains → `api.autofilm.io`
- Add Render's CNAME at your registrar

**Live URL:** `https://api.autofilm.io`

---

## Step 6 — Wire the backend into the frontend

In `frontend/autofilm-app.html`, find the `API_BASE` constant and update:

```javascript
// Change this:
const API_BASE = 'http://localhost:3001';
// To:
const API_BASE = 'https://api.autofilm.io';
```

Commit and push → Vercel auto-deploys.

---

## Step 7 — Supabase Auth (magic link login)

1. Supabase dashboard → Authentication → Settings
2. Enable Email provider
3. Customize email template with AutoFilm branding
4. Add your domain to "Site URL": `https://autofilm.io`

In `frontend/autofilm-app.html`, the login screen calls:
```javascript
supabase.auth.signInWithOtp({ email })
```
This is already wired — just needs the Supabase anon key in the HTML.

---

## Step 8 — Stripe (first paid customer)

1. stripe.com → Create account
2. Products → Create product: "AutoFilm Rooftop" → $299/month recurring
3. Payment Links → Create link for the product
4. Add the Stripe payment link to the billing page in `autofilm-command.html`

For webhook (auto-activate on payment):
- Stripe Dashboard → Developers → Webhooks → Add endpoint
- URL: `https://api.autofilm.io/api/stripe-webhook`
- Events: `checkout.session.completed`, `customer.subscription.deleted`

---

## Full end-to-end test

After all steps above:

1. Open `autofilm.io/app` on iPhone
2. Set up profile (name, dealer, photo)
3. Record a 30-second video
4. Fill in customer name + phone (use your own number)
5. Hit Send
6. Check your phone for the SMS
7. Open the link → video should play
8. Rep browser should get a push notification at 25%, 50%, 75%, 100%
9. Check Supabase → videos and watch_events tables should have rows
10. Open `autofilm.io/command` → should show the video in the activity feed

If all 10 work, you're ready to charge real money.

---

## Monitoring

- **Mux dashboard** — video health, playback errors, delivery stats
- **Twilio console** — SMS delivery rates, failed messages
- **Supabase dashboard** — database, auth users, real-time events
- **Render logs** — `https://dashboard.render.com` → your service → Logs
- **Vercel analytics** — page views, performance, error rates
- **Cloudflare Workers** — request counts, KV usage, error rates

---

## Cost at launch (5 Harte stores)

| Service | Monthly |
|---------|---------|
| Vercel Pro | $20 |
| Render Starter | $25 |
| Supabase Pro | $25 |
| Mux (est. 1,000 videos) | ~$35 |
| Twilio SMS (est. 1,000 msgs) | ~$8 |
| Cloudflare Workers | Free |
| **Total infra** | **~$113/mo** |
| **Revenue (5 rooftops)** | **$1,495/mo** |
| **Net** | **$1,382/mo · 92% margin** |
