import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { resolveTenant } from './lib/tenant.js';
import { rateLimit } from './lib/ratelimit.js';
import { startBDCAssistant } from './lib/bdc.js';
import { startWorkflowEngine } from './lib/workflows.js';

// Core routes
import uploadRoute from './routes/upload.js';
import sendRoute from './routes/send.js';
import pingRoute from './routes/ping.js';
import aiRoute from './routes/ai.js';

// Feature routes
import dashboardRoute from './routes/dashboard.js';
import vinReelsRoute from './routes/vinreels.js';
import mpiRoute from './routes/mpi.js';
import replyRoute from './routes/reply.js';
import onboardRoute from './routes/onboard.js';
import callRoute from './routes/call.js';

// Auth + Admin + Billing
import authRoute from './routes/auth.js';
import adminRoute from './routes/admin.js';
import billingRoute from './routes/billing.js';
import entitlementsRoute from './routes/entitlements.js';
import webhooksRoute from './routes/webhooks.js';

// AI features
import avatarRoute from './routes/avatar.js';

// Messaging + Distribution
import messagingRoute from './routes/messaging.js';
import distributeRoute from './routes/distribute.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ─────────────────────────────────────────────────────
// App surfaces get a strict allowlist. Public embed endpoints
// (player pings, widget calls, replies) get open CORS below,
// because they run on arbitrary dealer websites by design.
const APP_ORIGINS = [
  'https://autofilm.io',
  'https://www.autofilm.io',
  /\.autofilm\.io$/,
  'https://autocurb.io',
  /\.autocurb\.io$/,
  // Local dev
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const appCors = cors({
  origin: APP_ORIGINS,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Token', 'X-Api-Key'],
});

const publicCors = cors({ origin: true, methods: ['GET', 'POST', 'OPTIONS'] });

// Capture the raw body for webhook signature verification
// (Stripe and Mux both HMAC the exact bytes on the wire).
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Tenant resolution (runs on every request, non-blocking)
app.use(resolveTenant());

// Health check
app.get('/health', publicCors, (req, res) => {
  res.json({
    status: 'ok',
    version: '3.2.0',
    env: process.env.NODE_ENV,
    tenant: req.tenant?.mode || 'none',
    features: {
      billing: !!process.env.STRIPE_SECRET_KEY,
      bdc: !!process.env.HEYGEN_API_KEY,
      rcs: !!process.env.TWILIO_RCS_SENDER_ID,
      tts: !!(process.env.ELEVENLABS_API_KEY || process.env.GOOGLE_TTS_API_KEY),
    },
  });
});

// ── RATE LIMITS ──────────────────────────────────────────────
const authLimiter    = rateLimit({ windowMs: 60_000, max: 10 });   // brute-force guard
const sendLimiter    = rateLimit({ windowMs: 60_000, max: 30 });   // SMS abuse guard
const pingLimiter    = rateLimit({ windowMs: 60_000, max: 120 });  // player pings every 5s
const generalLimiter = rateLimit({ windowMs: 60_000, max: 120 });

// ── PUBLIC EMBED ENDPOINTS (open CORS — run on dealer sites) ─
app.use('/v', publicCors, pingLimiter, pingRoute);
app.use('/api/reply', publicCors, generalLimiter, replyRoute);
app.use('/api/call', publicCors, generalLimiter, callRoute);

// ── WEBHOOKS (no CORS needed — server-to-server) ─────────────
app.use('/api/webhooks', webhooksRoute);
// Twilio inbound + status callbacks live under messaging:
app.use('/api/messaging', publicCors, generalLimiter, messagingRoute);

// ── APP ROUTES (strict CORS) ─────────────────────────────────
app.use(appCors);

app.use('/api/auth', authLimiter, authRoute);
app.use('/api/billing', billingRoute);
app.use('/api/entitlements', generalLimiter, entitlementsRoute);

app.use('/api/upload', generalLimiter, uploadRoute);
app.use('/api/send', sendLimiter, sendRoute);
app.use('/api/ai-script', generalLimiter, aiRoute);

app.use('/api/dashboard', generalLimiter, dashboardRoute);
app.use('/api/vin-reels', generalLimiter, vinReelsRoute);
app.use('/api/mpi', generalLimiter, mpiRoute);
app.use('/api/onboard', authLimiter, onboardRoute);
app.use('/api/admin', generalLimiter, adminRoute);
app.use('/api/avatar', generalLimiter, avatarRoute);
app.use('/api/distribute', generalLimiter, distributeRoute);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── START SERVER ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[autofilm-api] v3.2.0 running on port ${PORT}`);
  console.log(`[autofilm-api] Env: ${process.env.NODE_ENV}`);

  // Background services
  startBDCAssistant();
  startWorkflowEngine();
});
