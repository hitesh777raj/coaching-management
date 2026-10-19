require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function testConnection() {
  try {
    console.log('Testing connection to Supabase...');
    const res = await pool.query('SELECT NOW()');
    console.log('🎉 SUCCESS! Connected to Supabase Database!');
    console.log('Current DB Time:', res.rows[0].now);
    process.exit(0);
  } catch (err) {
    console.error('❌ CONNECTION FAILED:', err.message);
    process.exit(1);
  }
}

testConnection();