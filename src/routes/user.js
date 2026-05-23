const router = require('express').Router();
const { db } = require('../db');
const { authMiddleware } = require('../middleware/auth');

router.get('/dashboard', authMiddleware, async (req, res) => {
  try {
    const lics = await db.query(
      'SELECT l.*, p.label as plan_label, p.features FROM licenses l LEFT JOIN plans p ON l.plan_name=p.name WHERE l.user_id=$1 ORDER BY l.created_at DESC',
      [req.user.id]
    );
    res.json({ success: true, user: { id:req.user.id, name:req.user.name, email:req.user.email }, licenses: lics.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Public plans
router.get('/plans', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM plans WHERE is_active=true ORDER BY price_usd ASC');
    res.json({ plans: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/contact', async (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'All fields required' });
  try {
    await db.query('INSERT INTO contacts(name,email,message) VALUES($1,$2,$3)', [name, email, message]);
    res.json({ success: true, message: 'Message sent! We will contact you soon.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
