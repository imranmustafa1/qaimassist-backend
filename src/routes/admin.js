const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db } = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

router.use(authMiddleware, adminOnly);

function generateKey() {
  const p = () => crypto.randomBytes(4).toString('hex').toUpperCase();
  return `QA-${p()}-${p()}-${p()}-${p()}`;
}
function generatePass(len=10) {
  return crypto.randomBytes(len).toString('base64').slice(0,len).replace(/[^a-zA-Z0-9]/g,'x');
}

router.get('/stats', async (req, res) => {
  try {
    const [users, licenses, contacts] = await Promise.all([
      db.query("SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE status='active') as active, COUNT(*) FILTER(WHERE created_at > NOW()-INTERVAL'30 days') as new_this_month FROM users WHERE role='user'"),
      db.query("SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE status='active') as active, COUNT(*) FILTER(WHERE status='expired') as expired, COUNT(*) FILTER(WHERE plan_name='monthly') as monthly, COUNT(*) FILTER(WHERE plan_name='yearly') as yearly, COUNT(*) FILTER(WHERE plan_name='lifetime') as lifetime FROM licenses"),
      db.query("SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE status='unread') as unread FROM contacts")
    ]);
    res.json({ users: users.rows[0], licenses: licenses.rows[0], contacts: contacts.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/users', async (req, res) => {
  const { search } = req.query;
  try {
    let q = `SELECT u.*, COUNT(l.id) as license_count, MAX(l.plan_name) as latest_plan FROM users u LEFT JOIN licenses l ON l.user_id=u.id WHERE u.role='user'`;
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` AND (u.email ILIKE $1 OR u.name ILIKE $1)`; }
    q += ` GROUP BY u.id ORDER BY u.created_at DESC LIMIT 100`;
    const r = await db.query(q, params);
    res.json({ users: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/create-user', async (req, res) => {
  const { email, name, plan, password: customPass } = req.body;
  if (!email || !plan) return res.status(400).json({ error: 'email and plan required' });
  try {
    const planInfo = await db.query('SELECT * FROM plans WHERE name=$1', [plan]);
    if (!planInfo.rows.length) return res.status(400).json({ error: 'Invalid plan' });
    const p = planInfo.rows[0];
    const password = customPass || generatePass();
    const hash = await bcrypt.hash(password, 10);
    const userName = name || email.split('@')[0];
    let userId;
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows.length) {
      userId = existing.rows[0].id;
      await db.query('UPDATE users SET password_hash=$1, name=$2, status=\'active\' WHERE id=$3', [hash, userName, userId]);
    } else {
      const ur = await db.query(
        "INSERT INTO users(name,email,password_hash,role,status) VALUES($1,$2,$3,'user','active') RETURNING id",
        [userName, email.toLowerCase(), hash]
      );
      userId = ur.rows[0].id;
    }
    const key = generateKey();
    const expiresAt = p.duration_days ? new Date(Date.now() + p.duration_days * 86400000) : null;
    await db.query(
      "INSERT INTO licenses(key,user_id,plan_name,status,expires_at) VALUES($1,$2,$3,'active',$4)",
      [key, userId, p.name, expiresAt]
    );
    const expStr = expiresAt ? new Date(expiresAt).toLocaleDateString() : 'Never';
    const waMsg = `🤖 *QaimAssist AI - Account Ready!*\n\n👤 Name: ${userName}\n📧 Email: ${email}\n🔐 Password: ${password}\n\n📦 Plan: ${p.label}${expiresAt?`\n📅 Expires: ${expStr}`:'\n♾️ Never expires'}\n\n🔑 *License Key:*\n${key}\n\n*Steps to activate:*\n1. Open Chrome Extension\n2. Enter email & password\n3. Click Login — Done! ✅\n\n_QaimAssist AI — Type Once. Let AI Do the Rest._`;
    res.json({ success: true, user: { email: email.toLowerCase(), name: userName, password }, license: { key, plan: p.name, label: p.label, expires_at: expiresAt }, whatsappMessage: waMsg });
  } catch(e) {
    console.error('Create user error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    await db.query('UPDATE users SET status=$1 WHERE id=$2', [req.body.status, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/licenses', async (req, res) => {
  const { search } = req.query;
  try {
    let q = 'SELECT l.*, u.name as user_name FROM licenses l LEFT JOIN users u ON l.user_id=u.id WHERE 1=1';
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` AND (l.email ILIKE $1 OR l.key ILIKE $1 OR u.email ILIKE $1)`; }
    q += ' ORDER BY l.created_at DESC LIMIT 200';
    const r = await db.query(q, params);
    // Add email from users table if missing on license
    const rows = r.rows.map(l => ({ ...l, email: l.email || l.user_name || 'N/A' }));
    res.json({ licenses: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/licenses/:key', async (req, res) => {
  try {
    await db.query('UPDATE licenses SET status=$1 WHERE key=$2', [req.body.status||'cancelled', req.params.key]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/licenses/:key/extend', async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    await db.query(
      `UPDATE licenses SET expires_at=COALESCE(expires_at,NOW())+($1::text || ' days')::interval, status='active' WHERE key=$2`,
      [days.toString(), req.params.key]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/settings', async (req, res) => {
  try {
    const r = await db.query('SELECT key, value, updated_at FROM settings');
    const s = {};
    r.rows.forEach(row => {
      s[row.key] = row.key.includes('key') && row.value ? row.value.substring(0,8)+'...'+row.value.slice(-4) : row.value;
    });
    res.json({ settings: s });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/settings', async (req, res) => {
  const { settings } = req.body;
  try {
    for (const [k, v] of Object.entries(settings || {})) {
      await db.query('INSERT INTO settings(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()', [k, v]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/contacts', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM contacts ORDER BY created_at DESC LIMIT 100');
    res.json({ contacts: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
