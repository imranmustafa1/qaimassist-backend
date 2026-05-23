require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { db, initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/user', require('./routes/user'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/license', require('./routes/license'));

// AI Routes
async function callGroq(prompt) {
  const r = await db.query("SELECT value FROM settings WHERE key='groq_api_key'");
  const apiKey = process.env.GROQ_API_KEY || r.rows[0]?.value || '';
  const m = await db.query("SELECT value FROM settings WHERE key='groq_model'");
  const model = m.rows[0]?.value || 'llama-3.1-8b-instant';
  if (!apiKey) throw new Error('Groq API key not configured');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 600 })
  });
  if (!res.ok) { const e = await res.json().catch(()=>{}); throw new Error(e?.error?.message || `Groq ${res.status}`); }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

const LANGS = { en:'English',ur:'Urdu',ar:'Arabic',hi:'Hindi',fr:'French',de:'German',es:'Spanish',zh:'Chinese',ru:'Russian',tr:'Turkish',ja:'Japanese',ko:'Korean' };

app.post('/api/translate', async (req, res) => {
  try {
    const { text, to='en' } = req.body;
    const t = await callGroq(`Expert translator. Input may be Roman Urdu, English, Urdu, or any language with typos. Translate into natural fluent ${LANGS[to]||to}. Return ONLY translated text.\nInput: ${text}`);
    res.json({ success: true, translated: t });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/grammar', async (req, res) => {
  try {
    const { text } = req.body;
    const c = await callGroq(`Fix ALL spelling and grammar errors. Keep same language. Return ONLY corrected text.\nInput: ${text}`);
    res.json({ success: true, corrected: c });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reply', async (req, res) => {
  try {
    const { text, tone='professional', replyLang='en' } = req.body;
    const TONES = { professional:'professional and formal',casual:'casual and friendly',friendly:'warm and friendly',persuasive:'persuasive and confident' };
    const r = await callGroq(`Someone sent: "${text}"\nWrite a ${TONES[tone]||'professional'} reply in ${LANGS[replyLang]||'English'}. 1-3 sentences.\nReturn ONLY the reply.`);
    res.json({ success: true, reply: r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/direct', async (req, res) => {
  try {
    const { prompt } = req.body;
    const r = await callGroq(prompt);
    res.json({ success: true, result: r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.json({ status: 'running', name: 'QaimAssist API', version: '5.0.0' }));

// ── Auto-expire cron job ──────────────────────────────────────
cron.schedule('0 * * * *', async () => {
  try {
    const r = await db.query("UPDATE licenses SET status='expired' WHERE expires_at < NOW() AND status='active' AND auto_expire=true RETURNING key");
    if (r.rows.length) console.log(`⏰ Expired ${r.rows.length} licenses`);
  } catch(e) { console.error('Cron error:', e.message); }
});

// Start
initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ QaimAssist API v5.0 running on port ${PORT}`));
}).catch(e => { console.error('Startup failed:', e); process.exit(1); });
