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

// Stats
router.get('/stats', async (req, res) => {
  try {
    const [users, licenses, contacts] = await Promise.all([
      db.query("SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE status='active') as active, COUNT(*) FILTER(WHERE created_at > NOW()-INTERVAL'30 days') as new_this_month FROM users WHERE role='user'"),
      db.query("SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE status='active') as active, COUNT(*) FILTER(WHERE status='expired') as expired, COUNT(*) FILTER(WHERE plan_name='monthly') as monthly, COUNT(*) FILTER(WHERE plan_name='yearly') as yearly, COUNT(*) FILTER(WHERE plan_name='lifetime') as lifetime, COUNT(*) FILTER(WHERE plan_name='trial') as trial FROM licenses"),
      db.query("SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE status='unread') as unread FROM contacts")
    ]);
    res.json({ users: users.rows[0], licenses: licenses.rows[0], contacts: contacts.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get all users
router.get('/users', async (req, res) => {
  const { search } = req.query;
  try {
    let q = `SELECT u.*, COUNT(l.id) as license_count, MAX(l.plan_name) as latest_plan, MAX(l.status) as license_status FROM users u LEFT JOIN licenses l ON l.user_id=u.id WHERE u.role='user'`;
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` AND (u.email ILIKE $1 OR u.name ILIKE $1)`; }
    q += ` GROUP BY u.id ORDER BY u.created_at DESC LIMIT 100`;
    const r = await db.query(q, params);
    res.json({ users: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create user — FIXED email null issue
router.post('/create-user', async (req, res) => {
  const { email, name, plan, password: customPass } = req.body;
  if (!email || !plan) return res.status(400).json({ error: 'email and plan required' });
  try {
    const planInfo = await db.query('SELECT * FROM plans WHERE name=$1', [plan]);
    if (!planInfo.rows.length) return res.status(400).json({ error: 'Invalid plan: ' + plan });
    const p = planInfo.rows[0];
    const password = customPass || generatePass();
    const hash = await bcrypt.hash(password, 10);
    const userName = (name || email.split('@')[0]).trim();
    const emailClean = email.toLowerCase().trim();
    let userId;
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [emailClean]);
    if (existing.rows.length) {
      userId = existing.rows[0].id;
      await db.query('UPDATE users SET password_hash=$1, name=$2, status=\'active\' WHERE id=$3', [hash, userName, userId]);
    } else {
      const ur = await db.query(
        "INSERT INTO users(name,email,password_hash,role,status) VALUES($1,$2,$3,'user','active') RETURNING id",
        [userName, emailClean, hash]
      );
      userId = ur.rows[0].id;
    }
    const key = generateKey();
    const expiresAt = p.duration_days ? new Date(Date.now() + p.duration_days * 86400000) : null;
    // FIXED: pass email explicitly to licenses table
    await db.query(
      "INSERT INTO licenses(key,user_id,email,plan_name,status,expires_at) VALUES($1,$2,$3,$4,'active',$5)",
      [key, userId, emailClean, p.name, expiresAt]
    );
    const expStr = expiresAt ? new Date(expiresAt).toLocaleDateString('en-PK') : 'Never expires';
    const waMsg = `🤖 *QaimAssist AI - Account Ready!*\n\n👤 Name: ${userName}\n📧 Email: ${emailClean}\n🔐 Password: ${password}\n\n📦 Plan: ${p.label}${expiresAt ? `\n📅 Expires: ${expStr}` : '\n♾️ Never expires'}\n\n🔑 *Your License Key:*\n${key}\n\n✅ *How to Activate:*\n1. Open Chrome Extension\n2. Enter email & password\n3. Click Login\n4. Start using AI features!\n\nSupport: wa.me/923001234567\n\n_QaimAssist AI — Type Once. Let AI Do the Rest._`;
    res.json({
      success: true,
      user: { email: emailClean, name: userName, password },
      license: { key, plan: p.name, label: p.label, expires_at: expiresAt },
      whatsappMessage: waMsg
    });
  } catch(e) {
    console.error('Create user error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Toggle user status
router.patch('/users/:id', async (req, res) => {
  try {
    await db.query('UPDATE users SET status=$1 WHERE id=$2', [req.body.status, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get all licenses with full details
router.get('/licenses', async (req, res) => {
  const { search } = req.query;
  try {
    let q = `SELECT l.*, u.name as user_name, u.email as user_email, p.label as plan_label, p.price_usd, p.price_pkr, p.duration_days
             FROM licenses l
             LEFT JOIN users u ON l.user_id=u.id
             LEFT JOIN plans p ON l.plan_name=p.name
             WHERE 1=1`;
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` AND (l.email ILIKE $1 OR l.key ILIKE $1 OR u.name ILIKE $1)`; }
    q += ' ORDER BY l.created_at DESC LIMIT 200';
    const r = await db.query(q, params);
    res.json({ licenses: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Revoke/update license status
router.patch('/licenses/:key', async (req, res) => {
  try {
    await db.query('UPDATE licenses SET status=$1 WHERE key=$2', [req.body.status||'cancelled', req.params.key]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Extend license
router.post('/licenses/:key/extend', async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    await db.query(
      `UPDATE licenses SET expires_at=COALESCE(expires_at,NOW()) + ($1::text||' days')::interval, status='active' WHERE key=$2`,
      [days.toString(), req.params.key]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Upgrade license plan
router.post('/licenses/:key/upgrade', async (req, res) => {
  const { plan } = req.body;
  try {
    const planInfo = await db.query('SELECT * FROM plans WHERE name=$1', [plan]);
    if (!planInfo.rows.length) return res.status(400).json({ error: 'Invalid plan' });
    const p = planInfo.rows[0];
    const expiresAt = p.duration_days ? new Date(Date.now() + p.duration_days * 86400000) : null;
    await db.query('UPDATE licenses SET plan_name=$1, expires_at=$2, status=\'active\' WHERE key=$3', [p.name, expiresAt, req.params.key]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Settings
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

// Contacts
router.get('/contacts', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM contacts ORDER BY created_at DESC LIMIT 100');
    res.json({ contacts: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Plans
router.get('/plans', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM plans ORDER BY price_usd ASC');
    res.json({ plans: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
