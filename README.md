# Mega Obese — เว็บ + API + PostgreSQL

```
หน้าเว็บ (public/index.html)  ⇄  API (server.js, Express)  ⇄  PostgreSQL (ดูใน pgAdmin)
```

## สิ่งที่ต้องมี
- Node.js 18 ขึ้นไป (ตรวจด้วย `node -v`)
- PostgreSQL + pgAdmin (มีอยู่แล้ว)

## วิธีติดตั้ง (ทำครั้งแรกครั้งเดียว)

1. **คัดลอกไฟล์ตั้งค่า** — ก๊อป `.env.example` แล้วเปลี่ยนชื่อเป็น `.env`
2. **แก้ `.env`** — ใส่รหัสผ่าน postgres ของคุณที่ `PGPASSWORD=`
   (ค่าอื่นดูได้ใน pgAdmin: คลิกขวาที่ server → Properties → Connection)
3. **ติดตั้ง package** — เปิด Terminal ในโฟลเดอร์นี้ แล้วพิมพ์
   ```
   npm install
   ```
4. **สร้างตาราง + ใส่ข้อมูล**
   ```
   npm run setup
   ```
   ถ้าขึ้น `✅ เสร็จแล้ว` แปลว่าผ่าน

## วิธีเปิดใช้งาน (ทุกครั้ง)
```
npm start
```
แล้วเปิดเบราว์เซอร์ไปที่ **http://localhost:3000**

## ดูข้อมูลใน pgAdmin
ฐานข้อมูล `northwind` → Schemas → **mega** → Tables

| ตาราง | เก็บอะไร |
|---|---|
| `products` | สินค้า ราคา สต็อก |
| `customers` | ลูกค้า |
| `employees` | พนักงาน |
| `transactions` | รายการขายทุกบรรทัด (`channel = 'online'` คือซื้อผ่านเว็บ) |
| `orders` / `order_items` | บิลที่ลูกค้าสั่งผ่านเว็บ |
| `accounts` | บัญชี login (รหัสผ่านถูกเข้ารหัส bcrypt) |
| `click_logs` | การคลิกบนหน้าเว็บ |

### ตาราง `db_7-11` เดิม (ใน schema public)
ทุกครั้งที่ลูกค้าซื้อ API จะบันทึกลงตารางนี้ด้วย:
- เพิ่มแถวรายการขาย (`"Order ID"`, `"Date"`, `"Time"`, `id_member`, `name_customer`, `id_product`, `name_product`, `"Quantity"`, `"Unit Price"`, `"Total Amount"`) 1 แถวต่อสินค้า 1 ชนิด
- ลด `"Current Stock"` และเพิ่ม `"Total Sold"` ของแถวสินค้า
- เพิ่ม `total_orders` และ `total_spend` ของแถวลูกค้า
- ตอนแอดมินแก้ราคาหรือสต็อก จะอัปเดต `price` และ `"Current Stock"` ด้วย

ปิดได้โดยใส่ `DB711_SYNC=false` ใน `.env`

ลองรันใน Query Tool:
```sql
SELECT * FROM mega.orders ORDER BY created_at DESC;
SELECT * FROM mega.order_items;
SELECT * FROM mega.customer_summary ORDER BY total_spend DESC;

-- ออเดอร์จากเว็บในตาราง db_7-11 เดิม
SELECT "Order ID", "Date", "Time", name_customer, name_product, "Quantity", "Total Amount"
FROM public."db_7-11"
WHERE "Order ID" LIKE 'TXN-%' AND "Date" >= CURRENT_DATE - 7
ORDER BY "Date" DESC, "Time" DESC;
```

## บัญชีเข้าระบบ
- ลูกค้า: รหัสสมาชิก (เช่น `6810301028`) / `1234`
- แอดมิน: `EMP001`–`EMP004` / `admin1234`

## API ที่มี
| Method | Path | ใครใช้ได้ |
|---|---|---|
| GET | `/api/health` | ทุกคน (เช็คว่าต่อ DB ได้) |
| POST | `/api/login` | ทุกคน |
| POST | `/api/clicks` | ทุกคน |
| GET | `/api/products` | ที่ login แล้ว |
| GET | `/api/my/orders` | ลูกค้า |
| POST | `/api/orders` | ลูกค้า |
| GET | `/api/admin/bootstrap` | แอดมิน |
| PUT | `/api/admin/products/:id` | แอดมิน |
| PUT / DELETE | `/api/admin/transactions/:id` | แอดมิน |

## เริ่มข้อมูลใหม่ทั้งหมด
```
npm run setup:reset
```
(ลบเฉพาะ schema `mega` — ตาราง `db_7-11` และ northwind เดิมไม่ถูกแตะ)

## ปัญหาที่พบบ่อย
- **`password authentication failed`** → รหัสใน `.env` ผิด
- **`database "northwind" does not exist`** → แก้ `PGDATABASE` ให้ตรงชื่อใน pgAdmin
- **`EADDRINUSE :3000`** → มีโปรแกรมอื่นใช้พอร์ต 3000 อยู่ (เช่น server เก็บคลิกตัวเดิม) ให้ปิดก่อน หรือเปลี่ยน `PORT`
- **หน้าเว็บขึ้น "เชื่อมต่อ server ไม่ได้"** → ยังไม่ได้รัน `npm start`
