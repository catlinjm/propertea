'use strict';
const jwt = require('jsonwebtoken');

function optionalAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  req.userId = null;
  if (token) {
    try {
      req.userId = jwt.verify(token, process.env.JWT_SECRET).userId;
    } catch { /* ignore */ }
  }
  next();
}

module.exports = optionalAuth;
