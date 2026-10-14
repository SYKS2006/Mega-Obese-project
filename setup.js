// สร้างตารางใน PostgreSQL + ใส่ข้อมูลเริ่มต้น + สร้างบัญชีผู้ใช้
//   npm run setup         → สร้างตาราง (ถ้ายังไม่มี) และใส่ข้อมูลถ้ายังว่าง
//   npm run setup:reset   → ลบ schema "mega" ทิ้งแล้วสร้างใหม่ทั้งหมด
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const ADMIN_CODES = ['EMP001', 'EMP002', 'EMP003', 'EMP004'];
const ADMIN_PASS = 'admin1234';
const CUSTOMER_PASS = '1234';

async function main() {
  const reset = process.argv.includes('--reset');
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error('❌ เชื่อมต่อ PostgreSQL ไม่ได้:', err.message);
    console.error('   ตรวจไฟล์ .env (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD) ให้ตรงกับใน pgAdmin');
    process.exitCode = 1;
    await pool.end();
    return;
  }
  try {
    await client.query('BEGIN');
    if (reset) {
      console.log('• ลบ schema mega เดิม');
      await client.query('DROP SCHEMA IF EXISTS mega CASCADE');
    }
    console.log('• สร้างตาราง');
    await client.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));

    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM mega.products');
    if (rows[0].n > 0) {
      console.log('• มีข้อมูลอยู่แล้ว ข้ามการใส่ข้อมูล (ใช้ npm run setup:reset ถ้าอยากเริ่มใหม่)');
      await client.query('COMMIT');
      return;
    }

    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'db', 'seed-data.json'), 'utf8'));

    console.log(`• ใส่พนักงาน ${data.employees.length} คน`);
    for (const e of data.employees) {
      await client.query(
        `INSERT INTO mega.employees VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [e.id, e.code, e.name, e.role, e.shiftStart, e.shiftEnd, e.salary, e.allowance, e.phone, e.hireDate, e.duty]
      );
    }

    console.log(`• ใส่ลูกค้า ${data.customers.length} คน`);
    for (const c of data.customers) {
      await client.query(`INSERT INTO mega.customers VALUES ($1,$2)`, [c.id, c.name]);
    }

    console.log(`• ใส่สินค้า ${data.products.length} รายการ`);
    for (const p of data.products) {
      await client.query(
        `INSERT INTO mega.products VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [p.id, p.barcode, p.name, p.cat, p.price, p.cost, p.stockCycle, p.cycles, p.maxAvail, p.current]
      );
    }

    console.log(`• ใส่ประวัติการขาย ${data.transactions.length} แถว`);
    for (const t of data.transactions) {
      await client.query(
        `INSERT INTO mega.transactions (order_code, order_date, order_time, member_id, product_id, quantity, unit_price, total_amount, channel)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'store')`,
        [t.o, t.d, t.t, t.m, t.p, t.q, t.u, t.tot]
      );
    }

    console.log('• สร้างบัญชีผู้ใช้');
    const adminHash = await bcrypt.hash(ADMIN_PASS, 10);
    const custHash = await bcrypt.hash(CUSTOMER_PASS, 10);
    for (const code of ADMIN_CODES) {
      await client.query(
        `INSERT INTO mega.accounts (username, password_hash, role, employee_code) VALUES ($1,$2,'admin',$1)`,
        [code, adminHash]
      );
    }
    for (const c of data.customers) {
      await client.query(
        `INSERT INTO mega.accounts (username, password_hash, role, member_id) VALUES ($1,$2,'customer',$3)`,
        [String(c.id), custHash, c.id]
      );
    }

    await client.query('COMMIT');
    console.log('✅ เสร็จแล้ว — ต่อไปพิมพ์ npm start');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ setup ไม่สำเร็จ:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
