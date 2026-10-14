require('dotenv').config();
const { Pool, types } = require('pg');

// ให้ตัวเลขออกมาเป็น number (ปกติ pg คืนค่าเป็น string)
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v))); // NUMERIC
types.setTypeParser(20, v => (v === null ? null : Number(v)));       // BIGINT
types.setTypeParser(1082, v => v);                                   // DATE → 'YYYY-MM-DD' ตรง ๆ ไม่แปลง timezone

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'northwind',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
});

module.exports = { pool };
