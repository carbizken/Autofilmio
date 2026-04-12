# AutoFilm — Claude Code Context

This file gives Claude Code full context to build the AutoFilm backend autonomously.
Place this file in the project root. Claude Code reads it at session start.

---

## What this project is

AutoFilm is a dealership video messaging SaaS. Sales reps record short personal videos
on mobile, send them via SMS, customers watch on a branded player page, and reps get
real-time push notifications when their video is opened.

**Pricing:** $299/rooftop/month, unlimited users, full product.

---

## Your job right now

Build the 3 backend endpoints in `backend/src/routes/`. The frontend is complete.
The backend is the only thing between this being a prototype and a real product.

---

## The 3 endpoints to build

### 1. POST /api/upload
```
Input:  multipart/form-data { video: File, rep_id: string, rooftop_id: string }
Steps:
  1. Validate rep_id exists in Supabase reps table
  2. Create Mux upload URL (direct upload)
  3. Upload video blob to Mux
  4. Wait for Mux asset to be ready (webhook or poll)
  5. Insert row into Supabase videos table:
     { rep_id, rooftop_id, mux_playback_id, short_code: nanoid(8) }
  6. Store short_code → full player URL in Cloudflare KV
Output: { playback_id, short_code, short_url }
```

### 2. POST /api/send
```
Input:  { short_code, customer_name, customer_phone, vehicle?, trade_url? }
Steps:
  1. Look up short_code in Supabase videos table
  2. Build player URL with all params (see Player URL format below)
  3. Store in Cloudflare KV: KV.put(short_code, player_url)
  4. Send Twilio SMS to customer_phone:
     "Hey [customer_name], [rep_name] recorded a personal video for you 🎬
      Watch it here: https://links.autofilm.io/v/[short_code]
      - [rep_name] · [dealer_name]"
  5. Update Supabase videos row: { sent_at: now(), customer_name, customer_phone }
Output: { success: true, sms_sid }
```

### 3. GET /v/:code/ping
```
Input:  URL param :code, query ?pct=number (watch percentage 0-100)
Steps:
  1. Look up video by short_code in Supabase
  2. Upsert into watch_events: { video_id, watch_pct: pct, watch_seconds, created_at }
  3. If pct crosses 25, 50, 75, or 100 for first time:
     Send Web Push notification to rep's browser subscription
     Notification: "[Customer Name] just watched [pct]% of your video — [vehicle]"
  4. Update videos table: { last_watched_at: now(), max_watch_pct: pct }
Output: { ok: true }
```

---

## Player URL format

The player page reads all context from URL params. Build this URL in POST /api/send:

```
https://autofilm.io/autofilm-player.html
  ?rep=Ken+Criscione
  &rep_display=Kenny
  &title=Sales+Consultant
  &dealer=Harte+Hyundai
  &web=harteautogroup.com
  &code=ABC12345
  &customer=John+Smith
  &vehicle=2025+Honda+Accord+Sport
  &phone=%2B12035551234
  &email=john%40example.com
  &trade_url=https%3A%2F%2Fhartecash.com%2Ftrade%3Fvin%3D...
  &color=%23D94F00
  &photo=https%3A%2F%2F...mux_thumbnail_url
```

If `vehicle` param is absent → player shows "Come In and See Us" mode (no trade CTA).
If `vehicle` param is present → player shows "Test Drive" + trade-in CTA.

---

## Supabase schema

```sql
-- Already created in Supabase dashboard. Use these exact table/column names.

reps (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nickname text,
  title text,
  dealer_id uuid references rooftops(id),
  email text unique not null,
  photo_url text,
  push_subscription jsonb,  -- Web Push subscription object
  created_at timestamptz default now()
)

rooftops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  dealer_group text,
  plan text default 'standard',
  stripe_customer_id text,
  active bool default true,
  created_at timestamptz default now()
)

videos (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid references reps(id),
  rooftop_id uuid references rooftops(id),
  mux_asset_id text,
  mux_playback_id text,
  customer_name text,
  customer_phone text,
  vehicle text,
  short_code text unique not null,
  sent_at timestamptz,
  last_watched_at timestamptz,
  max_watch_pct int default 0,
  created_at timestamptz default now()
)

watch_events (
  id uuid primary key default gen_random_uuid(),
  video_id uuid references videos(id),
  watch_pct int,
  watch_seconds int,
  ip text,
  user_agent text,
  created_at timestamptz default now()
)
```

---

## Environment variables

All secrets are in `.env` (never committed). Access via `process.env.VAR_NAME`.

```env
MUX_TOKEN_ID=           # Mux API token ID
MUX_TOKEN_SECRET=       # Mux API token secret
TWILIO_ACCOUNT_SID=     # Twilio account SID
TWILIO_AUTH_TOKEN=      # Twilio auth token
TWILIO_PHONE_NUMBER=    # +12035550001 format
SUPABASE_URL=           # https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=   # service role key (not anon)
ANTHROPIC_API_KEY=      # sk-ant-... (for AI script generation proxy)
CF_WORKER_URL=          # https://links.autofilm.io
CLOUDFLARE_API_TOKEN=   # For KV writes from Node
CLOUDFLARE_ACCOUNT_ID=  # CF account ID
CLOUDFLARE_KV_NAMESPACE_ID= # KV namespace for short links
VAPID_PUBLIC_KEY=       # Web Push VAPID public key
VAPID_PRIVATE_KEY=      # Web Push VAPID private key
VAPID_EMAIL=            # mailto:ken@harteautogroup.com
PORT=3001
```

---

## Tech stack

- **Runtime:** Node.js 20
- **Framework:** Express.js
- **Video:** @mux/mux-node
- **SMS:** twilio
- **Database:** @supabase/supabase-js
- **Push:** web-push
- **IDs:** nanoid
- **Upload parsing:** multer
- **Deploy:** Render.com (connected to this GitHub repo, auto-deploys on push to main)

---

## File structure to build

```
backend/
  src/
    routes/
      upload.js     ← POST /api/upload
      send.js       ← POST /api/send
      ping.js       ← GET /v/:code/ping
      ai.js         ← POST /api/ai-script (proxy for Anthropic)
    lib/
      mux.js        ← Mux client setup
      supabase.js   ← Supabase client setup
      twilio.js     ← Twilio client setup
      push.js       ← Web Push helpers
      cloudflare.js ← KV write helper
    index.js        ← Express app, route mounting, CORS, error handler
  package.json
  .env.example
```

---

## Code style

- ES modules (`import`/`export`) not CommonJS
- async/await everywhere, no callbacks
- All errors caught and returned as `{ error: string }` with appropriate HTTP status
- Log to console with prefix: `[upload]`, `[send]`, `[ping]`
- No TypeScript — plain JS is fine, we move fast

---

## Start command

```bash
cd backend
npm install
node src/index.js
```

Render will use `npm start` — set that in package.json scripts.

---

## What NOT to build

- Auth middleware (Supabase Auth handles sessions on the frontend)
- Admin routes (handled in autofilm-admin.html directly)
- Stripe webhooks (handled separately, not in this sprint)
- Any frontend HTML — the frontend is complete, don't touch it

---

## When you're done

Run `node src/index.js` and confirm:
1. POST /api/upload returns `{ playback_id, short_code, short_url }`
2. POST /api/send returns `{ success: true, sms_sid }`
3. GET /v/TESTCODE/ping?pct=50 returns `{ ok: true }`

Then push to GitHub. Render auto-deploys on push to main.
