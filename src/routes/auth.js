const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const exists = await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    if (exists.rows.length) return res.status(400).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const r = await db.query(
      "INSERT INTO users(name,email,password_hash,role,status) VALUES($1,$2,$3,'user','active') RETURNING id,name,email,role",
      [name.trim(), email.toLowerCase().trim(), hash]
    );
    const user = r.rows[0];
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user });
  } catch(e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const emailClean = email.toLowerCase().trim();
    const r = await db.query('SELECT * FROM users WHERE email=$1', [emailClean]);
    
    if (!r.rows.length) {
      console.log(`Login failed: no user with email ${emailClean}`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const user = r.rows[0];
    console.log(`Login attempt: ${emailClean}, role: ${user.role}, status: ${user.status}`);
    
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Account is disabled. Contact support.' });
    }
    
    const valid = await bcrypt.compare(password, user.password_hash);
    console.log(`Password valid: ${valid}`);
    
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    
    await db.query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);
    
    const lics = await db.query(
      'SELECT l.*, p.label as plan_label, p.features FROM licenses l LEFT JOIN plans p ON l.plan_name=p.name WHERE l.user_id=$1 ORDER BY l.created_at DESC',
      [user.id]
    );
    
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    res.json({
      success: true,
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      licenses: lics.rows
    });
  } catch(e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const lics = await db.query(
      'SELECT l.*, p.label as plan_label, p.features FROM licenses l LEFT JOIN plans p ON l.plan_name=p.name WHERE l.user_id=$1 ORDER BY l.created_at DESC',
      [req.user.id]
    );
    res.json({
      success: true,
      user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role },
      licenses: lics.rows
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  try {
    const valid = await bcrypt.compare(currentPassword, req.user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
