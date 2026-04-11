# AutoFilm

**Dealership video messaging platform.** Reps record personalized videos on mobile, send via SMS, customers watch on a branded player page, and the rep gets a real-time notification when the video is opened.

Built by Ken Criscione · Harte Auto Group · carbizken

---

## Platform overview

| File | Purpose | Status |
|------|---------|--------|
| `frontend/autofilm-app.html` | Rep mobile app — record, send, track | ✅ Complete |
| `frontend/autofilm-player.html` | Customer video player page | ✅ Complete |
| `frontend/autofilm-landing.html` | Public marketing page | ✅ Complete |
| `frontend/autofilm-command.html` | GM / dealer principal dashboard | ✅ Complete |
| `frontend/autofilm-admin.html` | Internal AutoFilm ops panel | ✅ Complete |
| `frontend/autofilm-pitch.html` | Investor / dealer pitch page with ROI calc | ✅ Complete |
| `frontend/autofilm-worker.js` | Cloudflare Worker — short links + watch pings | ✅ Spec complete, deploy pending |
| `frontend/hartecash-trade.html` | HarteCash trade-in landing (integrated CTA) | ✅ Complete |
| `backend/` | Node.js API — upload, send, ping | 🔧 In progress |

---

## Architecture

```
Rep App (autofilm-app.html)
  ↓ records video
  ↓ POST /api/upload → Mux (video hosting)
  ↓ POST /api/send → Cloudflare Worker KV (short link) → Twilio SMS
  
Customer opens SMS link
  → Cloudflare Worker redirects to autofilm-player.html?params
  → Player page loads Mux video
  → Every 5s: GET /v/:code/ping → Supabase watch_events
  → Push notification → rep's browser

GM Command (autofilm-command.html)
  → reads Supabase via Supabase JS client
  → real-time leaderboard, KPI dashboard, billing
```

### Tech stack

| Layer | Service | Cost |
|-------|---------|------|
| Frontend hosting | Vercel | $20/mo |
| API server | Render (Node.js) | $25/mo |
| Database | Supabase (Postgres + Auth) | $25/mo |
| Video | Mux | ~$0.003/video |
| SMS | Twilio | ~$0.0079/SMS |
| Short links | Cloudflare Workers | Free tier |
| Payments | Stripe | 2.9% + 30¢ |
| AI scripts | Anthropic API | Usage |

**Gross margin at scale: ~94–95%**

---

## Backend endpoints (3 to build)

```
POST /api/upload     — receive video blob → Mux → return playback_id
POST /api/send       — build short link → Twilio SMS → log to Supabase
GET  /v/:code/ping   — watch event → Supabase → push notification to rep
```

See `backend/` and `CLAUDE.md` for the full spec.

---

## Database schema (Supabase)

```sql
-- reps
id uuid, name text, nickname text, title text, dealer_id uuid, 
email text, photo_url text, created_at timestamptz

-- rooftops  
id uuid, name text, dealer_group text, plan text, 
stripe_customer_id text, active bool, created_at timestamptz

-- videos
id uuid, rep_id uuid, rooftop_id uuid, mux_playback_id text,
customer_name text, customer_phone text, vehicle text,
short_code text, sent_at timestamptz, created_at timestamptz

-- watch_events
id uuid, video_id uuid, watch_pct int, watch_seconds int,
ip text, user_agent text, created_at timestamptz
```

---

## Environment variables (Render)

```env
MUX_TOKEN_ID=
MUX_TOKEN_SECRET=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
ANTHROPIC_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_KV_NAMESPACE=
CLOUDFLARE_API_TOKEN=
CF_WORKER_URL=https://links.autofilm.io
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

---

## Pricing

**$299/rooftop/month · unlimited users · full product · no tiers**

Volume conversations happen in sales, not in the UI. White label available for dealer groups.

---

## Competitive position

| | AutoFilm | Covideo | CarFilm |
|--|---------|---------|---------|
| Price | $299/rooftop | $49/user | $495/rooftop |
| 10-user store/yr | $3,588 | $5,880 | $5,940 |
| AI scripts | Claude · 10 purposes | VIN only | None |
| Appointment booking | ✓ | — | — |
| Revenue attribution | ✓ | — | — |
| Lead scoring | ✓ | — | — |
| White label | ✓ | — | — |

---

## Roadmap

**Before first paid customer**
- [ ] Deploy Cloudflare Worker
- [ ] Build 3 backend endpoints (Render)
- [ ] Supabase Auth (magic link)
- [ ] Move Anthropic key server-side
- [ ] Stripe Checkout

**Q2**
- [ ] Command stub pages (Leaderboard, Rooftops, Activity)
- [ ] "Refer Your GM" button (after rep's 5th video)
- [ ] Day-21 automated GM outreach email
- [ ] Capacitor wrap for App Store

**Q3**
- [ ] CRM integration (VinSolutions, CDK)
- [ ] Custom dealer short domain (harte.video)
- [ ] Migrate to Cloudflare Stream (cheaper at 150+ rooftops)
