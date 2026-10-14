require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
const STORE_TZ = process.env.STORE_TZ || 'Asia/Bangkok';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- helpers ---------------- */
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

function auth(role) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    }
    if (role && req.user.role !== role) return res.status(403).json({ error: 'ไม่มีสิทธิ์ใช้งานส่วนนี้' });
    next();
  };
}

const PRODUCT_SQL = `
  SELECT product_id AS id, barcode, product_name AS name, category AS cat,
         price, cost_price AS cost, stock_per_cycle AS "stockCycle", total_sold::int AS sold,
         total_cycles AS cycles, max_available AS "maxAvail", current_stock AS current
  FROM mega.product_summary ORDER BY product_id`;

const TX_SQL = `
  SELECT t.id AS _id, t.order_code AS o, t.order_date AS d, t.order_time::text AS t,
         t.member_id AS m, c.customer_name AS cn, t.product_id AS p, p.product_name AS pn,
         t.quantity AS q, t.unit_price AS u, t.total_amount AS tot, (t.channel = 'online') AS online
  FROM mega.transactions t
  JOIN mega.customers c ON c.member_id = t.member_id
  JOIN mega.products  p ON p.product_id = t.product_id
  ORDER BY t.order_date, t.order_time, t.id`;

async function loadOrders(memberId) {
  const params = [];
  let where = '';
  if (memberId) { where = 'WHERE o.member_id = $1'; params.push(memberId); }
  const { rows } = await pool.query(`
    SELECT o.order_code AS code, o.order_date AS d, o.order_time::text AS t, o.member_id AS "memberId",
           c.customer_name AS name, o.total_amount AS total,
           json_agg(json_build_object('p', i.product_id, 'pn', i.product_name, 'q', i.quantity,
                                      'u', i.unit_price, 'tot', i.line_total) ORDER BY i.id) AS items
    FROM mega.orders o
    JOIN mega.customers c ON c.member_id = o.member_id
    JOIN mega.order_items i ON i.order_code = o.order_code
    ${where}
    GROUP BY o.order_code, c.customer_name
    ORDER BY o.created_at`, params);
  // json_agg คืน numeric เป็น number อยู่แล้ว
  return rows;
}

/* ---------------- ตาราง "db_7-11" เดิม ----------------
   ทุกครั้งที่ลูกค้าซื้อ จะ:
   1) เพิ่มแถวรายการขาย ("Order ID", "Date", "Time", id_member, ... ) 1 แถวต่อสินค้า 1 ชนิด
   2) ลด "Current Stock" และเพิ่ม "Total Sold" ของแถวสินค้า
   3) เพิ่ม total_orders / total_spend ของแถวลูกค้า
   ถ้าไม่มีตารางนี้ หรือบันทึกไม่สำเร็จ ออเดอร์ยังบันทึกลง schema mega ตามปกติ */
const DB711_SYNC = (process.env.DB711_SYNC || 'true').toLowerCase() !== 'false';
const DB711_TABLE = process.env.DB711_TABLE || 'public."db_7-11"';

async function syncToDb711(client, o) {
  if (!DB711_SYNC) return;
  const { rows: [chk] } = await client.query('SELECT to_regclass($1) AS t', [DB711_TABLE]);
  if (!chk.t) { console.warn(`⚠️  ไม่พบตาราง ${DB711_TABLE} — ข้ามการบันทึกลงตารางนี้`); return; }

  await client.query('SAVEPOINT db711');
  try {
    for (const i of o.items) {
      await client.query(
        `INSERT INTO ${DB711_TABLE}
           ("Order ID", "Date", "Time", id_member, name_customer, id_product, name_product, "Quantity", "Unit Price", "Total Amount")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [o.code, o.d, o.t, o.memberId, o.name, i.p, i.pn, i.q, i.u, i.tot]);
      await client.query(
        `UPDATE ${DB711_TABLE}
            SET "Current Stock" = GREATEST(COALESCE("Current Stock",0) - $1, 0),
                "Total Sold"    = COALESCE("Total Sold",0) + $1
          WHERE product_id = $2`,
        [i.q, i.p]);
    }
    await client.query(
      `UPDATE ${DB711_TABLE}
          SET total_orders = COALESCE(total_orders,0) + 1,
              total_spend  = COALESCE(total_spend,0) + $1
        WHERE member_id = $2`,
      [o.total, o.memberId]);
    await client.query('RELEASE SAVEPOINT db711');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT db711');
    console.warn(`⚠️  บันทึกลง ${DB711_TABLE} ไม่สำเร็จ (ออเดอร์ใน mega ยังบันทึกปกติ):`, err.message);
  }
}

/* ---------------- public ---------------- */
app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, db: process.env.PGDATABASE || 'northwind' });
}));

app.post('/api/login', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const key = /^emp/i.test(username) ? username.toUpperCase() : username;
  const { rows } = await pool.query(`
    SELECT a.username, a.password_hash, a.role, a.member_id, a.employee_code,
           COALESCE(c.customer_name, e.employee_name) AS name
    FROM mega.accounts a
    LEFT JOIN mega.customers c ON c.member_id = a.member_id
    LEFT JOIN mega.employees e ON e.employee_code = a.employee_code
    WHERE a.username = $1`, [key]);
  const acc = rows[0];
  if (!acc || !(await bcrypt.compare(password, acc.password_hash))) {
    return res.status(401).json({ error: 'รหัสผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  const user = { role: acc.role, id: acc.role === 'admin' ? acc.employee_code : acc.member_id, name: acc.name };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user });
}));

app.post('/api/clicks', wrap(async (req, res) => {
  const { element_id, page_url, session_id } = req.body || {};
  await pool.query(
    'INSERT INTO mega.click_logs (element_id, page_url, session_id) VALUES ($1,$2,$3)',
    [String(element_id || '').slice(0, 200), String(page_url || '').slice(0, 500), String(session_id || '').slice(0, 100)]
  );
  res.status(201).json({ ok: true });
}));

/* ---------------- customer ---------------- */
app.get('/api/products', auth(), wrap(async (req, res) => {
  res.json((await pool.query(PRODUCT_SQL)).rows);
}));

app.get('/api/my/orders', auth('customer'), wrap(async (req, res) => {
  res.json(await loadOrders(req.user.id));
}));

// สั่งซื้อ: body = { items: [{ productId, qty }] }
app.post('/api/orders', auth('customer'), wrap(async (req, res) => {
  const wanted = new Map();
  for (const it of req.body.items || []) {
    const id = Number(it.productId), q = Number(it.qty);
    if (!Number.isInteger(id) || !Number.isInteger(q) || q <= 0) {
      return res.status(400).json({ error: 'ข้อมูลสินค้าไม่ถูกต้อง' });
    }
    wanted.set(id, (wanted.get(id) || 0) + q);
  }
  if (!wanted.size) return res.status(400).json({ error: 'ตะกร้าว่าง' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7011)'); // กันเลขบิลซ้ำเวลาสั่งพร้อมกัน

    // ล็อกแถวสินค้า แล้วเช็คสต็อก + ใช้ราคาจากฐานข้อมูล (ไม่เชื่อราคาจากหน้าเว็บ)
    const ids = [...wanted.keys()];
    const { rows: prods } = await client.query(
      'SELECT product_id, product_name, price, current_stock FROM mega.products WHERE product_id = ANY($1) FOR UPDATE', [ids]);
    if (prods.length !== ids.length) throw Object.assign(new Error('ไม่พบสินค้าบางรายการ'), { status: 400 });
    for (const p of prods) {
      if (wanted.get(p.product_id) > p.current_stock) {
        throw Object.assign(new Error(`"${p.product_name}" เหลือในสต็อกแค่ ${p.current_stock} ชิ้น`), { status: 409 });
      }
    }

    const { rows: [now] } = await client.query(
      `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d, to_char(now() AT TIME ZONE $1, 'HH24:MI:SS') AS t`, [STORE_TZ]);
    const prefix = `TXN-${now.d.replace(/-/g, '')}-`;
    const { rows: [mx] } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(substr(order_code, $2), '\\D', '', 'g'), '')::int), 0) AS n
       FROM mega.transactions WHERE order_code LIKE $1`, [prefix + '%', prefix.length + 1]);
    const code = prefix + String(mx.n + 1).padStart(3, '0');

    const items = prods
      .sort((a, b) => ids.indexOf(a.product_id) - ids.indexOf(b.product_id))
      .map(p => {
        const q = wanted.get(p.product_id);
        return { p: p.product_id, pn: p.product_name, q, u: p.price, tot: +(q * p.price).toFixed(2) };
      });
    const total = +items.reduce((s, i) => s + i.tot, 0).toFixed(2);

    await client.query(
      'INSERT INTO mega.orders (order_code, member_id, order_date, order_time, total_amount) VALUES ($1,$2,$3,$4,$5)',
      [code, req.user.id, now.d, now.t, total]);
    for (const i of items) {
      await client.query(
        'INSERT INTO mega.order_items (order_code, product_id, product_name, quantity, unit_price, line_total) VALUES ($1,$2,$3,$4,$5,$6)',
        [code, i.p, i.pn, i.q, i.u, i.tot]);
      await client.query(
        `INSERT INTO mega.transactions (order_code, order_date, order_time, member_id, product_id, quantity, unit_price, total_amount, channel)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'online')`,
        [code, now.d, now.t, req.user.id, i.p, i.q, i.u, i.tot]);
      await client.query('UPDATE mega.products SET current_stock = current_stock - $1 WHERE product_id = $2', [i.q, i.p]);
    }

    // บันทึกลงตาราง "db_7-11" เดิมด้วย
    await syncToDb711(client, { code, d: now.d, t: now.t, memberId: req.user.id, name: req.user.name, total, items });

    await client.query('COMMIT');

    res.status(201).json({
      order: { code, d: now.d, t: now.t, memberId: req.user.id, name: req.user.name, total, items },
      products: (await pool.query(PRODUCT_SQL)).rows,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
}));

/* ---------------- admin ---------------- */
app.get('/api/admin/bootstrap', auth('admin'), wrap(async (req, res) => {
  const [tx, products, customers, employees, orders] = await Promise.all([
    pool.query(TX_SQL),
    pool.query(PRODUCT_SQL),
    pool.query(`SELECT member_id AS id, customer_name AS name, total_orders::int AS orders, total_spend AS spend
                FROM mega.customer_summary ORDER BY member_id`),
    pool.query(`SELECT employee_id AS id, employee_code AS code, employee_name AS name, role,
                       shift_start::text AS "shiftStart", shift_end::text AS "shiftEnd", salary, allowance,
                       phone, hire_date AS "hireDate", primary_duty AS duty
                FROM mega.employees ORDER BY employee_id`),
    loadOrders(),
  ]);
  res.json({
    transactions: tx.rows, products: products.rows, customers: customers.rows,
    employees: employees.rows, orders,
  });
}));

app.put('/api/admin/products/:id', auth('admin'), wrap(async (req, res) => {
  const price = Number(req.body.price), stock = Number(req.body.current);
  if (!(price >= 0) || !Number.isInteger(stock) || stock < 0) return res.status(400).json({ error: 'ราคาหรือสต็อกไม่ถูกต้อง' });
  const { rowCount } = await pool.query(
    'UPDATE mega.products SET price = $1, current_stock = $2 WHERE product_id = $3', [price, stock, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'ไม่พบสินค้า' });
  if (DB711_SYNC) {
    try {
      const { rows: [chk] } = await pool.query('SELECT to_regclass($1) AS t', [DB711_TABLE]);
      if (chk.t) await pool.query(`UPDATE ${DB711_TABLE} SET price = $1, "Current Stock" = $2 WHERE product_id = $3`, [price, stock, req.params.id]);
    } catch (err) { console.warn(`⚠️  อัปเดต ${DB711_TABLE} ไม่สำเร็จ:`, err.message); }
  }
  res.json({ ok: true });
}));

app.put('/api/admin/transactions/:id', auth('admin'), wrap(async (req, res) => {
  const q = Number(req.body.quantity), u = Number(req.body.unitPrice);
  if (!Number.isInteger(q) || q <= 0 || !(u >= 0)) return res.status(400).json({ error: 'จำนวนหรือราคาไม่ถูกต้อง' });
  const { rowCount } = await pool.query(
    'UPDATE mega.transactions SET quantity = $1, unit_price = $2, total_amount = ROUND(($1 * $2)::numeric, 2) WHERE id = $3',
    [q, u, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'ไม่พบรายการ' });
  res.json({ ok: true });
}));

app.delete('/api/admin/transactions/:id', auth('admin'), wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM mega.transactions WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'ไม่พบรายการ' });
  res.json({ ok: true });
}));

/* ---------------- errors ---------------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบ API นี้' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดที่ server: ' + err.message });
});

app.listen(PORT, () => {
  console.log(`🚀 Mega Obese API พร้อมแล้ว → http://localhost:${PORT}`);
});
