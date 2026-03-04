'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

const BRAND_COLORS = ['#3d6628','#8dc63f','#5a8f3c','#a8893a','#2d4a1e','#6aab28'];

// POST /api/v1/auth/register
router.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password || !displayName) {
    return res.status(400).json({ error: 'email, password, and displayName are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, avatar_color)
       VALUES ($1, $2, $3, $4) RETURNING id, email, display_name, avatar_color, created_at`,
      [email.toLowerCase().trim(), hash, displayName.trim(), BRAND_COLORS[0]]
    );
    const user = result.rows[0];
    // Update avatar color based on user id
    const color = BRAND_COLORS[user.id % BRAND_COLORS.length];
    await pool.query('UPDATE users SET avatar_color=$1 WHERE id=$2', [color, user.id]);
    user.avatar_color = color;

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: { id: user.id, email: user.email, displayName: user.display_name, avatarColor: user.avatar_color } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, display_name, avatar_color FROM users WHERE email=$1',
      [email.toLowerCase().trim()]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, displayName: user.display_name, avatarColor: user.avatar_color } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/v1/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, display_name, avatar_color, created_at FROM users WHERE id=$1',
      [req.userId]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, email: user.email, displayName: user.display_name, avatarColor: user.avatar_color, createdAt: user.created_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
