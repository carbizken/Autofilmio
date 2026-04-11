import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import uploadRoute from './routes/upload.js';
import sendRoute from './routes/send.js';
import pingRoute from './routes/ping.js';
import aiRoute from './routes/ai.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: [
    'https://autofilm.io',
    'https://www.autofilm.io',
    /\.autofilm\.io$/,
    // Local dev
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', env: process.env.NODE_ENV });
});

// Routes
app.use('/api/upload', uploadRoute);
app.use('/api/send', sendRoute);
app.use('/v', pingRoute);
app.use('/api/ai-script', aiRoute);

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
});
