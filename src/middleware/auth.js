const jwt = require('jsonwebtoken');
const { db } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'qaimassist_jwt_2024';

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const r = await db.query('SELECT * FROM users WHERE id=$1 AND status=$2', [decoded.userId, 'active']);
    if (!r.rows.length) return res.status(401).json({ error: 'User not found or disabled' });
    req.user = r.rows[0];
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminOnly(req, res, next) {
  if (!['admin','superadmin'].includes(req.user?.role)) return res.status(403).json({ error: 'Admin access required' });
  next();
}

function superAdminOnly(req, res, next) {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Super admin access required' });
  next();
}

module.exports = { authMiddleware, adminOnly, superAdminOnly, JWT_SECRET };
