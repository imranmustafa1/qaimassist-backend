const router = require('express').Router();
const { db } = require('../db');

router.post('/validate', async (req, res) => {
  const { key, deviceId } = req.body;
  if (!key || !deviceId) return res.status(400).json({ valid: false, error: 'Key and deviceId required' });
  try {
    const r = await db.query('SELECT * FROM licenses WHERE key=$1', [key]);
    if (!r.rows.length) return res.json({ valid: false, error: 'Invalid license key' });
    const lic = r.rows[0];
    if (lic.status !== 'active') return res.json({ valid: false, error: `License is ${lic.status}` });
    if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
      await db.query("UPDATE licenses SET status='expired' WHERE key=$1", [key]);
      return res.json({ valid: false, error: 'License has expired. Please renew your plan.' });
    }
    const dev = await db.query('SELECT * FROM activations WHERE license_key=$1 AND device_id=$2', [key, deviceId]);
    if (!dev.rows.length) {
      if (lic.devices_used >= lic.max_devices) return res.json({ valid: false, error: `Device limit reached (${lic.max_devices} devices max)` });
      await db.query('INSERT INTO activations(license_key,device_id) VALUES($1,$2)', [key, deviceId]);
      await db.query('UPDATE licenses SET devices_used=devices_used+1 WHERE key=$1', [key]);
    } else {
      await db.query('UPDATE activations SET last_seen=NOW() WHERE license_key=$1 AND device_id=$2', [key, deviceId]);
    }
    return res.json({ valid: true, plan: lic.plan_name, expires_at: lic.expires_at, message: 'License valid ✓' });
  } catch(e) { res.status(500).json({ valid: false, error: 'Server error' }); }
});

module.exports = router;
