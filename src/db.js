const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  // Step 1: Create tables with safe migrations
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'user',
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP
    );
  `);

  // Safe column additions
  const cols = [
    ['role', 'VARCHAR(20) DEFAULT \'user\''],
    ['name', 'VARCHAR(255)'],
    ['last_login', 'TIMESTAMP'],
    ['status', 'VARCHAR(20) DEFAULT \'active\'']
  ];
  for (const [col, def] of cols) {
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} ${def};`).catch(()=>{});
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) UNIQUE NOT NULL,
      label VARCHAR(100) NOT NULL,
      price_usd DECIMAL(10,2) NOT NULL,
      price_pkr INTEGER NOT NULL,
      duration_days INTEGER,
      features JSONB DEFAULT '[]',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS licenses (
      id SERIAL PRIMARY KEY,
      key VARCHAR(64) UNIQUE NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      plan_id INTEGER,
      plan_name VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'active',
      devices_used INTEGER DEFAULT 0,
      max_devices INTEGER DEFAULT 2,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP,
      auto_expire BOOLEAN DEFAULT true
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
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'unread',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Default settings
  const defaultSettings = [
    ['groq_api_key', process.env.GROQ_API_KEY || ''],
    ['groq_model', 'llama-3.1-8b-instant'],
    ['site_name', 'QaimAssist AI'],
    ['whatsapp_number', '+923001234567']
  ];
  for (const [k, v] of defaultSettings) {
    await db.query(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`, [k, v]);
  }

  // Default plans
  await db.query(`
    INSERT INTO plans(name,label,price_usd,price_pkr,duration_days,features) VALUES
      ('trial','Free Trial',0,0,7,'["All AI features","1 device","7 days access"]'),
      ('monthly','Monthly Plan',9,2500,30,'["All AI features","2 devices","30 days access","Email support"]'),
      ('yearly','Yearly Plan',69,19000,365,'["All AI features","2 devices","365 days access","Priority support","Save 36%"]'),
      ('lifetime','Lifetime Plan',149,41000,NULL,'["All AI features","2 devices","Lifetime access","Priority support","All future updates"]')
    ON CONFLICT(name) DO NOTHING;
  `);

  // Create superadmin with fresh bcrypt hash
  const bcrypt = require('bcryptjs');
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = await bcrypt.hash(adminPass, 10);
  
  // Check if admin exists
  const existing = await db.query("SELECT id,role FROM users WHERE email='admin@qaimassist.com'");
  if (existing.rows.length === 0) {
    await db.query(
      "INSERT INTO users(name,email,password_hash,role,status) VALUES('Super Admin','admin@qaimassist.com',$1,'superadmin','active')",
      [hash]
    );
    console.log('✅ Super admin created');
  } else {
    // Always update password hash and role to fix any mismatch
    await db.query(
      "UPDATE users SET password_hash=$1, role='superadmin', status='active', name='Super Admin' WHERE email='admin@qaimassist.com'",
      [hash]
    );
    console.log('✅ Super admin updated');
  }

  console.log('✅ Database ready');
}

module.exports = { db, initDB };
