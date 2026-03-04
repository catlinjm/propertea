'use strict';
const express = require('express');
const { pool } = require('../db');
const optionalAuth = require('../middleware/optionalAuth');

const router = express.Router();

// POST /api/v1/comments/:id/report
router.post('/:id/report', optionalAuth, async (req, res) => {
  const commentId = parseInt(req.params.id, 10);
  const { reason, fingerprint } = req.body;
  const userId = req.userId;

  const check = await pool.query('SELECT id FROM comments WHERE id=$1', [commentId]);
  if (!check.rows.length) return res.status(404).json({ error: 'Comment not found' });

  try {
    await pool.query(
      `INSERT INTO reports (comment_id, user_id, fingerprint, reason)
       VALUES ($1, $2, $3, $4)`,
      [commentId, userId || null, fingerprint || null, reason || 'inappropriate']
    );
    res.json({ reported: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
