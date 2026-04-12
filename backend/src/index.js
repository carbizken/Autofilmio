import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { resolveTenant } from './lib/tenant.js';
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

// Auth + Admin
import authRoute from './routes/auth.js';
import adminRoute from './routes/admin.js';

// AI features
import avatarRoute from './routes/avatar.js';

// Messaging + Distribution
import messagingRoute from './routes/messaging.js';
import distributeRoute from './routes/distribute.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ── MIDDLEWARE ───────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://autofilm.io',
    'https://www.autofilm.io',
    /\.autofilm\.io$/,
    // AutoCurb bundled mode
    'https://autocurb.io',
    /\.autocurb\.io$/,
    // Any dealer website (for widget + overlay)
    /./,
    // Local dev
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Token', 'X-Api-Key'],
}));

app.use(express.json({ limit: '10mb' }));

// Tenant resolution (runs on every request, non-blocking)
app.use(resolveTenant());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '3.0.0',
    env: process.env.NODE_ENV,
    tenant: req.tenant?.mode || 'none',
    features: {
      bdc: !!process.env.HEYGEN_API_KEY,
      rcs: !!process.env.TWILIO_RCS_SENDER_ID,
      youtube: !!process.env.YOUTUBE_API_KEY,
      tts: !!(process.env.ELEVENLABS_API_KEY || process.env.GOOGLE_TTS_API_KEY),
    },
  });
});

// ── AUTH ROUTES (no tenant required) ────────────────────────
app.use('/api/auth', authRoute);

// ── CORE ROUTES ─────────────────────────────────────────────
app.use('/api/upload', uploadRoute);
app.use('/api/send', sendRoute);
app.use('/v', pingRoute);
app.use('/api/ai-script', aiRoute);

// ── FEATURE ROUTES ──────────────────────────────────────────
app.use('/api/dashboard', dashboardRoute);
app.use('/api/vin-reels', vinReelsRoute);
app.use('/api/mpi', mpiRoute);
app.use('/api/reply', replyRoute);
app.use('/api/onboard', onboardRoute);
app.use('/api/call', callRoute);

// ── ADMIN ROUTES (auth + admin role required) ───────────────
app.use('/api/admin', adminRoute);

// ── AI FEATURES ─────────────────────────────────────────────
app.use('/api/avatar', avatarRoute);

// ── MESSAGING + DISTRIBUTION ────────────────────────────────
app.use('/api/messaging', messagingRoute);
app.use('/api/distribute', distributeRoute);

// ── TWILIO WEBHOOKS (no auth, Twilio signature validation in prod) ──
// These are also mounted under /api/messaging but listed for clarity:
// POST /api/messaging/webhook/inbound  — inbound SMS/RCS
// POST /api/messaging/webhook/status   — delivery receipts

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
  console.log(`[autofilm-api] v3.0.0 running on port ${PORT}`);
  console.log(`[autofilm-api] Env: ${process.env.NODE_ENV}`);

  // Start background services
  startBDCAssistant();
  startWorkflowEngine();
});
