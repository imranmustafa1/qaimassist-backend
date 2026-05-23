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

// Dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const [users, licenses, contacts, plans] = await Promise.all([
      db.query('SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE status=\'active\') as active, COUNT(*) FILTER(WHERE created_at > NOW()-INTERVAL\'30 days\') as new_this_month FROM users WHERE role=\'user\''),
      db.query('SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE status=\'active\') as active, COUNT(*) FILTER(WHERE status=\'expired\') as expired, COUNT(*) FILTER(WHERE plan_name=\'monthly\') as monthly, COUNT(*) FILTER(WHERE plan_name=\'yearly\') as yearly, COUNT(*) FILTER(WHERE plan_name=\'lifetime\') as lifetime FROM licenses'),
      db.query("SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE status='unread') as unread FROM contacts"),
      db.query('SELECT p.name, COUNT(l.id) as count FROM plans p LEFT JOIN licenses l ON l.plan_name=p.name GROUP BY p.name')
    ]);
    res.json({ users: users.rows[0], licenses: licenses.rows[0], contacts: contacts.rows[0], planStats: plans.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get all users
router.get('/users', async (req, res) => {
  const { search, page=1, limit=20 } = req.query;
  try {
    let query = `SELECT u.*, COUNT(l.id) as license_count, MAX(l.plan_name) as latest_plan, MAX(l.status) as license_status FROM users u LEFT JOIN licenses l ON l.user_id=u.id WHERE u.role='user'`;
    const params = [];
    if (search) { params.push(`%${search}%`); query += ` AND (u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`; }
    query += ` GROUP BY u.id ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${(page-1)*limit}`;
    const r = await db.query(query, params);
    const count = await db.query(`SELECT COUNT(*) FROM users WHERE role='user'${search?' AND (email ILIKE $1 OR name ILIKE $1)':''}`, search?[`%${search}%`]:[]);
    res.json({ users: r.rows, total: parseInt(count.rows[0].count) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create user + license
router.post('/create-user', async (req, res) => {
  const { email, name, plan, password: customPass } = req.body;
  if (!email || !plan) return res.status(400).json({ error: 'email and plan required' });
  try {
    const planInfo = await db.query('SELECT * FROM plans WHERE name=$1', [plan]);
    if (!planInfo.rows.length) return res.status(400).json({ error: 'Invalid plan' });
    const p = planInfo.rows[0];
    const password = customPass || generatePass();
    const hash = await bcrypt.hash(password, 10);
    let userId;
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows.length) {
      userId = existing.rows[0].id;
      if (customPass) await db.query('UPDATE users SET password_hash=$1,name=$2 WHERE id=$3', [hash, name||email.split('@')[0], userId]);
    } else {
      const ur = await db.query("INSERT INTO users(name,email,password_hash,role,status) VALUES($1,$2,$3,'user','active') RETURNING id", [name||email.split('@')[0], email.toLowerCase(), hash]);
      userId = ur.rows[0].id;
    }
    const key = generateKey();
    const expiresAt = p.duration_days ? new Date(Date.now() + p.duration_days * 86400000) : null;
    await db.query('INSERT INTO licenses(key,user_id,plan_id,plan_name,status,expires_at) VALUES($1,$2,$3,$4,\'active\',$5)', [key, userId, p.id, p.name, expiresAt]);
    const waMsg = `🤖 *QaimAssist AI - Account Ready!*\n\n👤 Name: ${name||email.split('@')[0]}\n📧 Email: ${email}\n🔑 Password: ${password}\n\n📦 Plan: ${p.label}${expiresAt?`\n📅 Expires: ${new Date(expiresAt).toLocaleDateString()}`:`\n♾️ Never expires`}\n\n*Your License Key:*\n\`${key}\`\n\n*Activation Steps:*\n1. Open Chrome Extension\n2. Enter email & password\n3. Click Login\n4. Done! ✅\n\nFor help: wa.me/923001234567\n\n_QaimAssist AI — Type Once. Let AI Do the Rest._`;
    res.json({ success: true, user: { email: email.toLowerCase(), name: name||email.split('@')[0], password }, license: { key, plan: p.name, label: p.label, expires_at: expiresAt }, whatsappMessage: waMsg });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Toggle user status
router.patch('/users/:id', async (req, res) => {
  const { status } = req.body;
  try {
    await db.query('UPDATE users SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get all licenses
router.get('/licenses', async (req, res) => {
  const { search } = req.query;
  try {
    let q = 'SELECT l.*, u.name as user_name FROM licenses l LEFT JOIN users u ON l.user_id=u.id WHERE 1=1';
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` AND (l.email ILIKE $1 OR l.key ILIKE $1)`; }
    q += ' ORDER BY l.created_at DESC LIMIT 200';
    const r = await db.query(q, params);
    res.json({ licenses: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Revoke license
router.patch('/licenses/:key', async (req, res) => {
  const { status } = req.body;
  try {
    await db.query('UPDATE licenses SET status=$1 WHERE key=$2', [status||'cancelled', req.params.key]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Extend license
router.post('/licenses/:key/extend', async (req, res) => {
  const { days } = req.body;
  try {
    await db.query("UPDATE licenses SET expires_at=COALESCE(expires_at,NOW())+($1 || ' days')::interval, status='active' WHERE key=$2", [days, req.params.key]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get settings
router.get('/settings', async (req, res) => {
  try {
    const r = await db.query('SELECT key, value, updated_at FROM settings');
    const s = {};
    r.rows.forEach(row => { s[row.key] = row.key.includes('key') && row.value ? row.value.substring(0,8)+'...'+row.value.slice(-4) : row.value; });
    res.json({ settings: s });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Save settings
router.post('/settings', async (req, res) => {
  const { settings } = req.body;
  try {
    for (const [k, v] of Object.entries(settings||{})) {
      await db.query('INSERT INTO settings(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()', [k, v]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get plans
router.get('/plans', async (req, res) => {
  const r = await db.query('SELECT * FROM plans ORDER BY price_usd ASC');
  res.json({ plans: r.rows });
});

// Get contacts
router.get('/contacts', async (req, res) => {
  const r = await db.query('SELECT * FROM contacts ORDER BY created_at DESC LIMIT 100');
  res.json({ contacts: r.rows });
});

module.exports = router;
