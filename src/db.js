const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
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
      email VARCHAR(255),
      plan_name VARCHAR(50) NOT NULL DEFAULT 'trial',
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

  // Safe migrations
  const migrations = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP",
    "ALTER TABLE licenses ADD COLUMN IF NOT EXISTS plan_name VARCHAR(50) DEFAULT 'trial'",
    "ALTER TABLE licenses ADD COLUMN IF NOT EXISTS email VARCHAR(255)",
    "ALTER TABLE licenses ADD COLUMN IF NOT EXISTS auto_expire BOOLEAN DEFAULT true",
    "ALTER TABLE licenses ADD COLUMN IF NOT EXISTS user_id INTEGER",
  ];
  for (const sql of migrations) {
    await db.query(sql).catch(() => {});
  }

  // Fix null emails in licenses
  await db.query(`UPDATE licenses l SET email=u.email FROM users u WHERE l.user_id=u.id AND l.email IS NULL`).catch(() => {});
  await db.query(`UPDATE licenses SET plan_name='monthly' WHERE plan_name IS NULL OR plan_name=''`).catch(() => {});

  // Default settings
  for (const [k, v] of [
    ['groq_api_key', process.env.GROQ_API_KEY || ''],
    ['groq_model', 'llama-3.1-8b-instant'],
    ['site_name', 'QaimAssist AI'],
    ['whatsapp_number', '+923001234567']
  ]) {
    await db.query(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`, [k, v]);
  }

  // Default plans
  await db.query(`
    INSERT INTO plans(name,label,price_usd,price_pkr,duration_days,features) VALUES
      ('trial','Free Trial',0,0,7,'["All AI features","1 device","7 days access","Basic support"]'),
      ('monthly','Monthly Plan',9,2500,30,'["All AI features","2 devices","30 days access","Email support","Grammar fix","AI Reply"]'),
      ('yearly','Yearly Plan',69,19000,365,'["All AI features","2 devices","365 days access","Priority support","Save 36%","All features"]'),
      ('lifetime','Lifetime Plan',149,41000,NULL,'["All AI features","2 devices","Lifetime access","Priority support","All future updates","Unlimited usage"]')
    ON CONFLICT(name) DO NOTHING;
  `);

  // Superadmin
  const bcrypt = require('bcryptjs');
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = await bcrypt.hash(adminPass, 10);
  const existing = await db.query("SELECT id FROM users WHERE email='admin@qaimassist.com'");
  if (!existing.rows.length) {
    await db.query("INSERT INTO users(name,email,password_hash,role,status) VALUES('Super Admin','admin@qaimassist.com',$1,'superadmin','active')", [hash]);
  } else {
    await db.query("UPDATE users SET password_hash=$1,role='superadmin',status='active',name='Super Admin' WHERE email='admin@qaimassist.com'", [hash]);
  }
  console.log(`✅ DB ready | Admin: admin@qaimassist.com / ${adminPass}`);
}

module.exports = { db, initDB };
