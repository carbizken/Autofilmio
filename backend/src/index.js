import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { resolveTenant } from './lib/tenant.js';

import uploadRoute from './routes/upload.js';
import sendRoute from './routes/send.js';
import pingRoute from './routes/ping.js';
import aiRoute from './routes/ai.js';
import dashboardRoute from './routes/dashboard.js';
import vinReelsRoute from './routes/vinreels.js';
import mpiRoute from './routes/mpi.js';
import replyRoute from './routes/reply.js';
import onboardRoute from './routes/onboard.js';
import callRoute from './routes/call.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: [
    'https://autofilm.io',
    'https://www.autofilm.io',
    /\.autofilm\.io$/,
    // AutoCurb bundled mode
    'https://autocurb.io',
    /\.autocurb\.io$/,
    // Local dev
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Token', 'X-Api-Key'],
}));

app.use(express.json({ limit: '10mb' }));

// Tenant resolution (runs on every request, non-blocking)
app.use(resolveTenant());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    env: process.env.NODE_ENV,
    tenant: req.tenant?.mode || 'none',
  });
});

// ── CORE ROUTES ─────────────────────────────────────────────
app.use('/api/upload', uploadRoute);
app.use('/api/send', sendRoute);
app.use('/v', pingRoute);
app.use('/api/ai-script', aiRoute);

// ── NEW FEATURE ROUTES ──────────────────────────────────────
app.use('/api/dashboard', dashboardRoute);
app.use('/api/vin-reels', vinReelsRoute);
app.use('/api/mpi', mpiRoute);
app.use('/api/reply', replyRoute);
app.use('/api/onboard', onboardRoute);
app.use('/api/call', callRoute);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[autofilm-api] Running on port ${PORT}`);
  console.log(`[autofilm-api] Env: ${process.env.NODE_ENV}`);
  console.log(`[autofilm-api] Tenant resolver: active`);
});
