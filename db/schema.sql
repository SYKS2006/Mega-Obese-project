-- ============================================================
--  Mega Obese — โครงสร้างฐานข้อมูลสำหรับเว็บ (PostgreSQL)
--  ใช้ schema "mega" แยกออกมา จะไม่ไปยุ่งกับตาราง northwind หรือ "db_7-11" เดิม
-- ============================================================
CREATE SCHEMA IF NOT EXISTS mega;

-- พนักงาน
CREATE TABLE IF NOT EXISTS mega.employees (
  employee_id   INTEGER PRIMARY KEY,
  employee_code VARCHAR(20) UNIQUE NOT NULL,
  employee_name VARCHAR(100) NOT NULL,
  role          VARCHAR(50),
  shift_start   TIME,
  shift_end     TIME,
  salary        NUMERIC(10,2),
  allowance     NUMERIC(10,2),
  phone         VARCHAR(20),
  hire_date     DATE,
  primary_duty  TEXT
);

-- ลูกค้า (สมาชิก)
CREATE TABLE IF NOT EXISTS mega.customers (
  member_id     BIGINT PRIMARY KEY,
  customer_name VARCHAR(255) NOT NULL
);

-- สินค้า + สต็อก
CREATE TABLE IF NOT EXISTS mega.products (
  product_id      INTEGER PRIMARY KEY,
  barcode         VARCHAR(50),
  product_name    VARCHAR(255) NOT NULL,
  category        VARCHAR(100) NOT NULL,
  price           NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  cost_price      NUMERIC(10,2) NOT NULL CHECK (cost_price >= 0),
  stock_per_cycle INTEGER NOT NULL DEFAULT 15,
  total_cycles    INTEGER NOT NULL DEFAULT 0,
  max_available   INTEGER NOT NULL DEFAULT 0,
  current_stock   INTEGER NOT NULL DEFAULT 0 CHECK (current_stock >= 0)
);

-- รายการขายทุกบรรทัด (ทั้งข้อมูลเดิม และที่ลูกค้าซื้อผ่านเว็บ)
CREATE TABLE IF NOT EXISTS mega.transactions (
  id           SERIAL PRIMARY KEY,
  order_code   VARCHAR(50) NOT NULL,
  order_date   DATE NOT NULL,
  order_time   TIME NOT NULL,
  member_id    BIGINT NOT NULL REFERENCES mega.customers(member_id),
  product_id   INTEGER NOT NULL REFERENCES mega.products(product_id),
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  unit_price   NUMERIC(10,2) NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL,
  channel      VARCHAR(10) NOT NULL DEFAULT 'store' CHECK (channel IN ('store','online'))
);
CREATE INDEX IF NOT EXISTS idx_tx_member ON mega.transactions(member_id);
CREATE INDEX IF NOT EXISTS idx_tx_order  ON mega.transactions(order_code);

-- หัวบิลของคำสั่งซื้อออนไลน์
CREATE TABLE IF NOT EXISTS mega.orders (
  order_code   VARCHAR(50) PRIMARY KEY,
  member_id    BIGINT NOT NULL REFERENCES mega.customers(member_id),
  order_date   DATE NOT NULL,
  order_time   TIME NOT NULL,
  total_amount NUMERIC(12,2) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- รายการสินค้าในแต่ละคำสั่งซื้อออนไลน์
CREATE TABLE IF NOT EXISTS mega.order_items (
  id           SERIAL PRIMARY KEY,
  order_code   VARCHAR(50) NOT NULL REFERENCES mega.orders(order_code) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES mega.products(product_id),
  product_name VARCHAR(255) NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  unit_price   NUMERIC(10,2) NOT NULL,
  line_total   NUMERIC(10,2) NOT NULL
);

-- บัญชีเข้าระบบ (รหัสผ่านเก็บแบบเข้ารหัส bcrypt)
CREATE TABLE IF NOT EXISTS mega.accounts (
  username      VARCHAR(50) PRIMARY KEY,         -- รหัสสมาชิก หรือ EMP00X
  password_hash TEXT NOT NULL,
  role          VARCHAR(10) NOT NULL CHECK (role IN ('admin','customer')),
  member_id     BIGINT REFERENCES mega.customers(member_id),
  employee_code VARCHAR(20) REFERENCES mega.employees(employee_code)
);

-- เก็บการคลิกบนหน้าเว็บ
CREATE TABLE IF NOT EXISTS mega.click_logs (
  id         SERIAL PRIMARY KEY,
  element_id TEXT,
  page_url   TEXT,
  session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- สรุปยอดลูกค้า (คำนวณจาก transactions ทุกครั้ง จึงตรงเสมอ)
CREATE OR REPLACE VIEW mega.customer_summary AS
SELECT c.member_id,
       c.customer_name,
       COUNT(DISTINCT t.order_code)        AS total_orders,
       COALESCE(SUM(t.total_amount), 0)    AS total_spend
FROM mega.customers c
LEFT JOIN mega.transactions t ON t.member_id = c.member_id
GROUP BY c.member_id, c.customer_name;

-- สรุปยอดขายสินค้า
CREATE OR REPLACE VIEW mega.product_summary AS
SELECT p.*,
       COALESCE(SUM(t.quantity), 0) AS total_sold
FROM mega.products p
LEFT JOIN mega.transactions t ON t.product_id = p.product_id
GROUP BY p.product_id;
