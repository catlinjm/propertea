'use strict';
const express = require('express');
const { pool } = require('../db');
const requireAuth = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');
const { timeAgo } = require('../utils/time');

const router = express.Router({ mergeParams: true });

const BRAND_COLORS = ['#3d6628','#8dc63f','#5a8f3c','#a8893a','#2d4a1e','#6aab28'];

function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function colorForAnon(name) {
  return BRAND_COLORS[djb2(name) % BRAND_COLORS.length];
}

function formatComment(row) {
  return {
    id:               row.id,
    author:           row.author_name,
    color:            row.author_color,
    text:             row.body,
    time:             timeAgo(row.created_at),
    createdAt:        row.created_at,
    parentCommentId:  row.parent_comment_id || null,
    userId:           row.user_id || null,
    likeCount:        parseInt(row.like_count, 10) || 0,
    replies:          [],
  };
}

// GET /api/v1/listings/:mlsId/comments
router.get('/', async (req, res) => {
  const { mlsId } = req.params;
  try {
    const result = await pool.query(
      `SELECT c.*, COUNT(l.id)::int AS like_count
       FROM comments c
       LEFT JOIN likes l ON l.comment_id = c.id
       WHERE c.listing_mlsid = $1
       GROUP BY c.id
       ORDER BY c.created_at ASC`,
      [mlsId]
    );

    // Nest replies under parents
    const map = {};
    const roots = [];
    for (const row of result.rows) {
      map[row.id] = formatComment(row);
    }
    for (const row of result.rows) {
      if (row.parent_comment_id && map[row.parent_comment_id]) {
        map[row.parent_comment_id].replies.push(map[row.id]);
      } else {
        roots.push(map[row.id]);
      }
    }

    res.json(roots);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/v1/listings/:mlsId/comments
router.post('/', optionalAuth, async (req, res) => {
  const { mlsId } = req.params;
  const { author, text, parentCommentId } = req.body;

  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

  let authorName, authorColor, userId;

  if (req.userId) {
    // Authenticated user
    const userResult = await pool.query(
      'SELECT display_name, avatar_color FROM users WHERE id=$1',
      [req.userId]
    );
    if (!userResult.rows.length) return res.status(401).json({ error: 'User not found' });
    authorName  = userResult.rows[0].display_name;
    authorColor = userResult.rows[0].avatar_color;
    userId      = req.userId;
  } else {
    // Anonymous
    if (!author || !author.trim()) return res.status(400).json({ error: 'author is required for anonymous comments' });
    authorName  = author.trim().slice(0, 80);
    authorColor = colorForAnon(authorName);
    userId      = null;
  }

  // Validate parent exists in same listing
  if (parentCommentId) {
    const parent = await pool.query(
      'SELECT id FROM comments WHERE id=$1 AND listing_mlsid=$2',
      [parentCommentId, mlsId]
    );
    if (!parent.rows.length) return res.status(400).json({ error: 'Parent comment not found' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO comments (listing_mlsid, user_id, author_name, author_color, body, parent_comment_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [mlsId, userId, authorName, authorColor, text.trim().slice(0, 2000), parentCommentId || null]
    );
    const row = result.rows[0];
    res.status(201).json({ ...formatComment(row), likeCount: 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/v1/listings/:mlsId/comments/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const { mlsId, id } = req.params;
  try {
    const result = await pool.query(
      'SELECT user_id FROM comments WHERE id=$1 AND listing_mlsid=$2',
      [id, mlsId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Comment not found' });
    if (result.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your comment' });

    await pool.query('DELETE FROM comments WHERE id=$1', [id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
