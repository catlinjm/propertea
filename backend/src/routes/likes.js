'use strict';
const express = require('express');
const { pool } = require('../db');
const optionalAuth = require('../middleware/optionalAuth');

const router = express.Router();

// POST /api/v1/comments/:id/like  (toggles — adds or removes)
router.post('/:id/like', optionalAuth, async (req, res) => {
  const commentId = parseInt(req.params.id, 10);
  const { fingerprint } = req.body;
  const userId = req.userId;

  // Verify comment exists
  const check = await pool.query('SELECT id FROM comments WHERE id=$1', [commentId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Comment not found' });

  try {
    if (userId) {
      // Authenticated toggle
      const existing = await pool.query(
        'SELECT id FROM likes WHERE comment_id=$1 AND user_id=$2',
        [commentId, userId]
      );
      if (existing.rows.length) {
        await pool.query('DELETE FROM likes WHERE comment_id=$1 AND user_id=$2', [commentId, userId]);
        return res.json({ liked: false });
      }
      await pool.query(
        'INSERT INTO likes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [commentId, userId]
      );
      return res.json({ liked: true });
    } else if (fingerprint) {
      // Anonymous toggle by fingerprint
      const existing = await pool.query(
        'SELECT id FROM likes WHERE comment_id=$1 AND fingerprint=$2',
        [commentId, fingerprint]
      );
      if (existing.rows.length) {
        await pool.query('DELETE FROM likes WHERE comment_id=$1 AND fingerprint=$2', [commentId, fingerprint]);
        return res.json({ liked: false });
      }
      await pool.query(
        'INSERT INTO likes (comment_id, fingerprint) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [commentId, fingerprint]
      );
      return res.json({ liked: true });
    } else {
      return res.status(400).json({ error: 'Must provide fingerprint for anonymous likes' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/v1/comments/:id/like (explicit unlike)
router.delete('/:id/like', optionalAuth, async (req, res) => {
  const commentId = parseInt(req.params.id, 10);
  const { fingerprint } = req.body;
  const userId = req.userId;

  try {
    if (userId) {
      await pool.query('DELETE FROM likes WHERE comment_id=$1 AND user_id=$2', [commentId, userId]);
    } else if (fingerprint) {
      await pool.query('DELETE FROM likes WHERE comment_id=$1 AND fingerprint=$2', [commentId, fingerprint]);
    } else {
      return res.status(400).json({ error: 'Must provide fingerprint for anonymous unlike' });
    }
    res.json({ liked: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
