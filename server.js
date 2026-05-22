require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'qaimassist_secret_2024';

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Database ──────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS licenses (
      id SERIAL PRIMARY KEY,
      key VARCHAR(64) UNIQUE NOT NULL,
      user_id INTEGER REFERENCES users(id),
      email VARCHAR(255) NOT NULL,
      plan VARCHAR(20) NOT NULL,
      status VARCHAR(20) DEFAULT 'active',
      devices_used INTEGER DEFAULT 0,
      max_devices INTEGER DEFAULT 2,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS activations (
      id SERIAL PRIMARY KEY,
      license_key VARCHAR(64) NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      activated_at TIMESTAMP DEFAULT NOW(),
      last_seen TIMESTAMP DEFAULT NOW(),
      UNIQUE(license_key, device_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    INSERT INTO settings(key,value) VALUES('groq_api_key','') ON CONFLICT(key) DO NOTHING;
    INSERT INTO settings(key,value) VALUES('groq_model','llama-3.1-8b-instant') ON CONFLICT(key) DO NOTHING;
  `);
  console.log('✅ DB ready');
}

// ── Helpers ───────────────────────────────────────────────────
function generateKey() {
  const p = () => crypto.randomBytes(4).toString('hex').toUpperCase();
  return `QA-${p()}-${p()}-${p()}-${p()}`;
}
function generatePass(len = 10) {
  return crypto.randomBytes(len).toString('base64').slice(0, len).replace(/[^a-zA-Z0-9]/g, 'x');
}
async function getSetting(key) {
  const r = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
  return r.rows[0]?.value || '';
}
async function setSetting(key, value) {
  await db.query('INSERT INTO settings(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()', [key, value]);
}
function isAdmin(req) {
  return (req.body?.adminKey || req.query?.adminKey) === ADMIN_KEY;
}

const PLANS = {
  trial:    { days: 7,   label: '🎁 Free Trial' },
  monthly:  { days: 30,  label: '📅 Monthly' },
  yearly:   { days: 365, label: '🔥 Yearly' },
  lifetime: { days: null, label: '♾️ Lifetime' }
};

// ── Groq AI ───────────────────────────────────────────────────
async function callGroq(prompt) {
  const apiKey = process.env.GROQ_API_KEY || await getSetting('groq_api_key');
  const model = await getSetting('groq_model') || 'llama-3.1-8b-instant';
  if (!apiKey) throw new Error('Groq API key not configured. Set it in admin settings.');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 600 })
  });
  if (!res.ok) { const e = await res.json().catch(() => {}); throw new Error(e?.error?.message || `Groq error ${res.status}`); }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty response');
  return text;
}

// ── AI Routes ─────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'running', name: 'QaimAssist API', version: '4.0.0' }));

app.post('/api/translate', async (req, res) => {
  const { text, to = 'en' } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  const LANGS = { en:'English',ur:'Urdu',ar:'Arabic',hi:'Hindi',fr:'French',de:'German',es:'Spanish',zh:'Chinese',ru:'Russian',tr:'Turkish',ja:'Japanese',ko:'Korean' };
  try {
    const translated = await callGroq(`You are an expert AI translator. Input may be Roman Urdu, English, Urdu script, or any language with typos/shorthand. Understand the TRUE meaning and translate into natural fluent ${LANGS[to]||to}. Return ONLY the translated text. No quotes. No explanation.\nInput: ${text}`);
    res.json({ success: true, translated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/grammar', async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const corrected = await callGroq(`Fix ALL spelling and grammar errors. Keep same language. Return ONLY corrected text.\nInput: ${text}`);
    res.json({ success: true, corrected });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reply', async (req, res) => {
  const { text, tone = 'professional', replyLang = 'en' } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  const LANGS = { en:'English',ur:'Urdu',ar:'Arabic',hi:'Hindi',fr:'French',de:'German',es:'Spanish',zh:'Chinese',ru:'Russian',tr:'Turkish',ja:'Japanese',ko:'Korean' };
  const TONES = { professional:'professional and formal',casual:'casual and friendly',friendly:'warm and friendly',persuasive:'persuasive and confident' };
  try {
    const reply = await callGroq(`Someone sent: "${text}"\nWrite a ${TONES[tone]||'professional'} reply in ${LANGS[replyLang]||'English'}. 1-3 sentences. Natural.\nReturn ONLY the reply.`);
    res.json({ success: true, reply });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/direct', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'prompt required' });
  try {
    const result = await callGroq(prompt);
    res.json({ success: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── User Auth ─────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const r = await db.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid email or password' });
    const user = r.rows[0];
    if (user.status !== 'active') return res.status(403).json({ error: 'Account disabled' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    const lics = await db.query('SELECT * FROM licenses WHERE user_id=$1 ORDER BY created_at DESC', [user.id]);
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name }, licenses: lics.rows });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await db.query('SELECT * FROM users WHERE id=$1', [decoded.userId]);
    if (!user.rows.length) return res.status(401).json({ error: 'User not found' });
    const lics = await db.query('SELECT * FROM licenses WHERE user_id=$1 ORDER BY created_at DESC', [decoded.userId]);
    res.json({ success: true, user: user.rows[0], licenses: lics.rows });
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
});

// ── License Validate ──────────────────────────────────────────
app.post('/api/license/validate', async (req, res) => {
  const { key, deviceId } = req.body;
  if (!key || !deviceId) return res.status(400).json({ valid: false, error: 'Key and deviceId required' });
  try {
    const r = await db.query('SELECT * FROM licenses WHERE key=$1', [key]);
    if (!r.rows.length) return res.json({ valid: false, error: 'Invalid license key' });
    const lic = r.rows[0];
    if (lic.status !== 'active') return res.json({ valid: false, error: 'License ' + lic.status });
    if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
      await db.query("UPDATE licenses SET status='expired' WHERE key=$1", [key]);
      return res.json({ valid: false, error: 'License expired' });
    }
    const dev = await db.query('SELECT * FROM activations WHERE license_key=$1 AND device_id=$2', [key, deviceId]);
    if (!dev.rows.length) {
      if (lic.devices_used >= lic.max_devices) return res.json({ valid: false, error: `Device limit reached (${lic.max_devices} max)` });
      await db.query('INSERT INTO activations(license_key,device_id) VALUES($1,$2)', [key, deviceId]);
      await db.query('UPDATE licenses SET devices_used=devices_used+1 WHERE key=$1', [key]);
    } else {
      await db.query('UPDATE activations SET last_seen=NOW() WHERE license_key=$1 AND device_id=$2', [key, deviceId]);
    }
    return res.json({ valid: true, plan: lic.plan, email: lic.email, expires_at: lic.expires_at });
  } catch(e) { res.status(500).json({ valid: false, error: 'Server error' }); }
});

// ── Admin Routes ──────────────────────────────────────────────
app.post('/api/admin/create-user', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  const { email, name, plan, password: customPass } = req.body;
  if (!email || !plan) return res.status(400).json({ error: 'email and plan required' });
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  try {
    const password = customPass || generatePass();
    const hash = await bcrypt.hash(password, 10);
    let userId;
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows.length) {
      userId = existing.rows[0].id;
      if (customPass) await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
    } else {
      const ur = await db.query('INSERT INTO users(email,password_hash,name,status) VALUES($1,$2,$3,\'active\') RETURNING id', [email.toLowerCase(), hash, name || email.split('@')[0]]);
      userId = ur.rows[0].id;
    }
    const key = generateKey();
    const expiresAt = PLANS[plan].days ? new Date(Date.now() + PLANS[plan].days * 86400000) : null;
    await db.query('INSERT INTO licenses(key,user_id,email,plan,status,expires_at) VALUES($1,$2,$3,$4,\'active\',$5)', [key, userId, email.toLowerCase(), plan, expiresAt]);
    const waMsg = `🤖 *QaimAssist AI - Account Ready!*\n\n📧 Email: ${email}\n🔑 Password: ${password}\n\n📦 Plan: ${PLANS[plan].label}${expiresAt ? `\n📅 Expires: ${new Date(expiresAt).toLocaleDateString()}` : '\n♾️ Never expires'}\n\n*License Key:*\n\`${key}\`\n\n*How to activate:*\n1. Open Chrome extension\n2. Enter email & password\n3. Click Login\n4. Done! ✅\n\n_QaimAssist AI - Type Once. Let AI Do the Rest._`;
    res.json({ success: true, user: { email: email.toLowerCase(), name: name || email.split('@')[0], password }, license: { key, plan, expires_at: expiresAt }, whatsappMessage: waMsg });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  try {
    const r = await db.query(`SELECT u.*, COUNT(l.id) as license_count, MAX(l.plan) as latest_plan, MAX(l.status) as license_status FROM users u LEFT JOIN licenses l ON l.user_id=u.id GROUP BY u.id ORDER BY u.created_at DESC`);
    res.json({ users: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/licenses', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  const r = await db.query('SELECT * FROM licenses ORDER BY created_at DESC LIMIT 500');
  res.json({ licenses: r.rows });
});

app.post('/api/admin/revoke', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  await db.query("UPDATE licenses SET status='cancelled' WHERE key=$1", [req.body.key]);
  res.json({ success: true });
});

app.post('/api/admin/disable-user', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  await db.query("UPDATE users SET status='disabled' WHERE email=$1", [req.body.email]);
  res.json({ success: true });
});

app.get('/api/admin/settings', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  const r = await db.query('SELECT key, value, updated_at FROM settings');
  const s = {};
  r.rows.forEach(row => { s[row.key] = row.key.includes('key') && row.value ? row.value.substring(0,8)+'...'+row.value.slice(-4) : row.value; });
  res.json({ settings: s });
});

app.post('/api/admin/settings', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Unauthorized' });
  const { settings } = req.body;
  for (const [k, v] of Object.entries(settings || {})) await setSetting(k, v);
  res.json({ success: true });
});

// ── Start ─────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ QaimAssist API v4.0 on port ${PORT}`));
}).catch(e => { console.error(e); process.exit(1); });
