const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  // Add missing columns if they don't exist (safe migration)
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'user',
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP
    );
  `);

  // Safe column additions for existing tables
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';`);

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
      plan_id INTEGER REFERENCES plans(id),
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
  await db.query(`INSERT INTO settings(key,value) VALUES('groq_api_key','') ON CONFLICT(key) DO NOTHING;`);
  await db.query(`INSERT INTO settings(key,value) VALUES('groq_model','llama-3.1-8b-instant') ON CONFLICT(key) DO NOTHING;`);
  await db.query(`INSERT INTO settings(key,value) VALUES('site_name','QaimAssist AI') ON CONFLICT(key) DO NOTHING;`);
  await db.query(`INSERT INTO settings(key,value) VALUES('whatsapp_number','+923001234567') ON CONFLICT(key) DO NOTHING;`);

  // Default plans
  await db.query(`
    INSERT INTO plans(name,label,price_usd,price_pkr,duration_days,features) VALUES
      ('trial','Free Trial',0,0,7,'["All AI features","1 device","7 days access"]'),
      ('monthly','Monthly Plan',9,2500,30,'["All AI features","2 devices","30 days access","Email support"]'),
      ('yearly','Yearly Plan',69,19000,365,'["All AI features","2 devices","365 days access","Priority support","Save 36%"]'),
      ('lifetime','Lifetime Plan',149,41000,NULL,'["All AI features","2 devices","Lifetime access","Priority support","All future updates"]')
    ON CONFLICT(name) DO NOTHING;
  `);

  // Default superadmin (password: admin123)
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('admin123', 10);
  await db.query(`
    INSERT INTO users(name,email,password_hash,role,status)
    VALUES('Super Admin','admin@qaimassist.com',$1,'superadmin','active')
    ON CONFLICT(email) DO UPDATE SET role='superadmin', name='Super Admin';
  `, [hash]);

  console.log('✅ Database initialized successfully');
}

module.exports = { db, initDB };
