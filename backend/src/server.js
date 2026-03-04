'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express  = require('express');
const cors     = require('cors');
const { migrate } = require('./db');

const listingsRouter = require('./routes/listings');
const commentsRouter = require('./routes/comments');
const likesRouter    = require('./routes/likes');
const reportsRouter  = require('./routes/reports');
const authRouter     = require('./routes/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// CORS
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(/\s+/).filter(Boolean);
app.use(cors({
  origin: function (origin, cb) {
    // Allow requests with no origin (file://, Postman, curl)
    if (!origin) return cb(null, true);
    // '*' in the list means allow all origins
    if (allowedOrigins.length === 0 || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

app.use(express.json());

// Health check
app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Routes
app.use('/api/v1/listings',          listingsRouter);
app.use('/api/v1/listings/:mlsId/comments', commentsRouter);
app.use('/api/v1/comments',          likesRouter);
app.use('/api/v1/comments',          reportsRouter);
app.use('/api/v1/auth',              authRouter);

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Start
async function start() {
  try {
    await migrate();
  } catch (err) {
    console.warn('Migration warning (safe to ignore if tables exist):', err.message);
  }
  app.listen(PORT, () => console.log(`ProperTea API listening on port ${PORT}`));
}

start();
