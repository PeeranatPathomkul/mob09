# mob09 — Flash Sale System

Backend Assignment (Mobile Application Development)

ระบบ Flash Sale ที่ออกแบบมาให้รับ **ผู้อ่าน 1,000 คนพร้อมกัน** และ **ผู้ซื้อ 500 คนแย่งของ 50 ชิ้น**
โดยที่ **ต้องไม่ oversell** และต้องไม่มีใครซื้อได้เกิน 1 ชิ้นต่อ 1 สินค้า

**Stack:** NestJS · PostgreSQL (TypeORM) · Redis · BullMQ · Nginx · JWT (stateless)

---

## สารบัญ

- [ภาพรวมสถาปัตยกรรม](#ภาพรวมสถาปัตยกรรม)
- [Quick start](#quick-start)
- [API Spec](#api-spec)
- [การแบ่งงาน 3 คน](#การแบ่งงาน-3-คน)
- [ส่วนที่ 1 — moo: Read Path (Cache Optimization)](#ส่วนที่-1--moo-read-path-cache-optimization)
- [ส่วนที่ 2 — kao: Write Path ขาเข้า (Distributed Lock)](#ส่วนที่-2--kao-write-path-ขาเข้า-distributed-lock)
- [ส่วนที่ 3 — Gus: Write Path ขาประมวลผล (DB Transaction & Throughput)](#ส่วนที่-3--gus-write-path-ขาประมวลผล-db-transaction--throughput)
- [Infrastructure: Nginx + Load Balancing](#infrastructure-nginx--load-balancing)
- [Load testing](#load-testing)
- [Configuration](#configuration)
- [ข้อจำกัดที่รู้ตัว](#ข้อจำกัดที่รู้ตัว-known-limitations)

---

## ภาพรวมสถาปัตยกรรม

```
                            Clients / k6
                                 |
                          Nginx  :8080
                        (least_conn LB)
                                 |
              +------------------+------------------+
              |                  |                  |
           api1:3000         api2:3000          api3:3000     <- stateless, JWT only
              |                  |                  |
              +--------+---------+---------+--------+
                       |                   |
                   Postgres              Redis  :6380
                  (products,          (page cache, version
                   orders)             counter, entry locks,
                       |                BullMQ queue)
                       |                   |
                       +-------- worker ---+                  <- BullMQ consumer,
                                 |                               ตัดสต็อกใน transaction
                            Bull Board :4001
```

### ทำไมต้องแยก worker ออกมาเป็น service ต่างหาก

`POST /api/v1/orders` ต้องตอบเร็ว (ตาม spec ข้อ 2.3) ดังนั้น API layer จะทำแค่ 2 อย่างคือ
**จอง Redis lock** แล้ว **โยนงานเข้า queue** จากนั้นตอบ `202 Accepted` ทันที
งานที่แตะฐานข้อมูลทั้งหมด (ตัดสต็อก + สร้าง order row) เกิดที่ worker ภายใน transaction เดียว

การแยกแบบนี้ให้ประโยชน์ 3 ข้อ:

1. **เวลาตอบของ API ไม่ผูกกับความเร็วของ DB** — ต่อให้ 500 คนแย่ง row เดียวกันจนคิวยาว
   ผู้ใช้ก็ยังได้ response กลับไปในหลัก ms
2. **คุมความขนานฝั่ง DB ได้อิสระ** — จำนวน request ที่เข้ามา (500) ไม่เท่ากับจำนวน transaction
   ที่วิ่งเข้า Postgres พร้อมกัน (คุมด้วย `WORKER_CONCURRENCY`) ถ้าไม่แยกเราจะคุมไม่ได้เลย
3. **งานไม่หายและ retry ได้** — BullMQ เก็บ job ไว้ใน Redis ถ้า worker ตายกลางทาง job ยังอยู่

ในโค้ด `api1/api2/api3` โหลด `AppModule` ซึ่ง **จงใจไม่ import BullMQ processor**
มีแต่ service `worker` เท่านั้นที่โหลด `WorkerModule` — ถ้าเผลอ import ผิด API instance
จะกลายเป็น consumer ไปด้วย แล้ว `WORKER_CONCURRENCY` ที่ตั้งไว้จะถูกคูณ 4 โดยไม่รู้ตัว

---

## Quick start

```bash
cp .env.example .env          # แล้วแก้ JWT_SECRET
docker compose up -d --build
docker compose exec api1 node dist/database/seed.js
```

seed ทำครั้งเดียวพอ เพราะ Postgres volume เก็บข้อมูลไว้ เช็คว่า seed แล้วหรือยัง:

```bash
docker compose exec -T postgres psql -U postgres -d flash_sale -tAc "SELECT count(*) FROM products;"
```

| Service | URL |
|---|---|
| API (ผ่าน nginx) | http://localhost:8080 |
| Bull Board (queue dashboard) | http://localhost:4001/admin/queues |
| Redis (สำหรับ tool ฝั่ง host) | localhost:6380 |

Postgres และ API แต่ละตัว **ไม่ publish port ออก host** — เข้าถึงผ่าน `docker compose exec`
หรือผ่าน nginx เท่านั้น เพื่อบังคับให้ทุก request เดินผ่าน load balancer จริง ๆ

> Redis map เป็น `6380` ไม่ใช่ `6379` เพราะเครื่องที่พัฒนามี Redis ตัวอื่นจอง 6379 อยู่แล้ว
> ถ้า tool ฝั่ง host ชี้ผิดตัว มันจะรายงานว่า queue ว่างเปล่าแบบเงียบ ๆ ซึ่งหลอกมาก

---

## API Spec

ทุก endpoint ทำตาม spec กลางที่ตกลงกันทั้งห้อง เพื่อให้ script load test ของแต่ละกลุ่ม
เอาไปยิงระบบของกลุ่มอื่นได้เลย

### `POST /api/v1/auth/token`

```json
{ "userId": "user-999" }
```
→ `200 OK` · `{ "status": "success", "accessToken": "eyJ..." }`

`userId` ที่ว่างหรือไม่ส่งมาจะถูกปฏิเสธด้วย `400` — **ไม่ใช่** ออก token ที่ไม่มี `sub` ให้

> ทำไมต้องเช็ค: ตอนแรกส่ง body `{}` มาก็ยังได้ token 200 กลับไป (เพราะ `jwt.sign` ตัด claim
> ที่เป็น `undefined` ทิ้ง) token นั้นผ่าน guard ได้ และ `POST /orders` ก็ตอบ 202 —
> สัญญากับผู้ใช้ว่าสั่งซื้อเข้าคิวแล้ว ทั้งที่ worker จะไปตายตอน INSERT เพราะ `user_id NOT NULL`
> แปลว่ามีแค่ constraint ของ Postgres เท่านั้นที่กั้นคนไม่มีตัวตนออกจากการสั่งซื้อ
>
> เหตุผลที่ปฏิเสธที่ controller ไม่ใช่ที่ guard: ผู้เรียกจะได้ `400 userId is required`
> ณ จุดที่แก้ไขได้ แทนที่จะได้ token ที่จู่ ๆ ใช้ไม่ได้ในอีกหนึ่ง request ถัดมา

### `GET /api/v1/products?page=1&limit=10`

→ `200 OK` · `{ "status": "success", "data": [...], "meta": { total, page, limit, totalPages } }`

เสิร์ฟผ่าน Redis page cache ทุก response จะแนบ header **`X-Cache`** = `HIT` / `MISS` / `BYPASS`
ซึ่งเป็นมุมมองเดียวที่บอกได้ว่า *request นี้* cache ทำงานอย่างไร

`page` ถูก clamp ที่ 1000 และ `limit` ถูก snap ขึ้นเป็นค่าใดค่าหนึ่งใน `10 / 20 / 50 / 100`
(เหตุผลอยู่ในส่วนของ moo — เรื่อง cache penetration)

### `POST /api/v1/orders`

Header: `Authorization: Bearer <token>` · Body: `{ "productId": "p-1001" }`

→ `202 Accepted` · `{ "status": "processing", "orderJobId": "...", "message": "..." }`

**ไม่รับ `quantity` จาก client** — กติกา 1 คน 1 ชิ้นต่อสินค้า เป็นกฎฝั่ง server
กดซ้ำจะได้ `orderJobId` **ตัวเดิม** กลับไป ไม่ใช่ error เพื่อให้ client retry ได้แบบ idempotent

### `GET /api/v1/cache/stats`

→ `{ hits, misses, errors, hitRate, currentVersion, redisAvailable }`
เป็นยอดรวมระดับ process สำหรับทำรายงาน อ่านอย่างเดียว การ poll ไม่ขยับตัวเลข

---

## การแบ่งงาน 3 คน

| คน | ส่วนที่รับผิดชอบ | ไฟล์หลัก | สคริปต์พิสูจน์ |
|---|---|---|---|
| **moo** | Read path — cache-aside + version counter, TTL, กัน stampede, hit/miss | `api/src/cache/*`, `api/src/products/*` | `test-1-moo-cache.sh` |
| **kao** | Write path (ขาเข้า) — Redis atomic lock, TTL/release, idempotency | `orders.service.ts`, `orders-lock.util.ts`, `orders-lock-release.listener.ts` | `test-2-kao-lock.sh` |
| **Gus** | Write path (ขาประมวลผล) — DB transaction, locking strategy, worker/pool tuning | `stock-claim.service.ts`, `orders.processor.ts` | `test-3-gus-throughput.sh` |

ทั้งสามส่วนมาเจอกันที่ `test-4-full-system.sh` ซึ่งยิง read + write พร้อมกัน

---

## ส่วนที่ 1 — moo: Read Path (Cache Optimization)

> โจทย์: `GET /api/v1/products` ต้องรับผู้อ่าน 1,000 คนพร้อมกัน โดยที่ Postgres ไม่ล้ม
> และตัวเลข `remainingStock` ต้องไม่ค้างจนหลอกผู้ใช้

ไฟล์หลัก: [api/src/cache/product-cache.service.ts](api/src/cache/product-cache.service.ts)
· [api/src/cache/dto/list-products-query.dto.ts](api/src/cache/dto/list-products-query.dto.ts)
· [api/src/cache/README.md](api/src/cache/README.md)

### 1.1 เลือกใช้: Cache-Aside + Version Counter (ไม่ใช่ DEL รายคีย์ / ไม่ใช่ SCAN)

**สิ่งที่ใช้:** cache ทั้งหน้าเป็น JSON ก้อนเดียว เก็บใต้คีย์

```
products:page:{page}:limit:{limit}:v:{version}
```

โดย `{version}` มาจาก counter ตัวเดียวใน Redis (`products:cache:version`)
ที่ worker สั่ง `INCR` **หนึ่งครั้งต่อทุก order ที่ commit สำเร็จ**

**ทำไมถึงเลือกแบบนี้:**

| ทางเลือกที่พิจารณา | ปัญหา | สรุป |
|---|---|---|
| `DEL` ทุกคีย์ตอนสต็อกเปลี่ยน | ต้องรู้ก่อนว่ามีคีย์อะไรอยู่บ้าง → ต้อง `SCAN` ซึ่งเป็น O(n) และต้องวิ่งบ่อยมากตอน flash sale | ❌ |
| `KEYS products:page:*` แล้วค่อย DEL | `KEYS` บล็อก Redis ทั้งตัว ห้ามใช้บน production | ❌ |
| ตั้ง TTL สั้นมาก ๆ อย่างเดียว (เช่น 1 วินาที) | ยังเห็นสต็อกเก่าได้นานถึง 1 วินาที และ hit rate ตกฮวบ | ❌ |
| **Version counter** | `INCR` ครั้งเดียว = **O(1)** → คีย์เก่าทุกหน้า "ตาย" พร้อมกันทันที เพราะ reader หันไปหาคีย์ `:v:` ใหม่ ไม่ต้องลบอะไรเลยสักคีย์ | ✅ **เลือกอันนี้** |

คีย์ของเวอร์ชันเก่าไม่ถูกลบ แต่หมดอายุเองด้วย TTL — TTL จึงทำหน้าที่แค่ "เก็บกวาด"
**ไม่ใช่ตัวรักษาความถูกต้อง** ความถูกต้องมาจาก version bump

### 1.2 เลือกใช้: TTL แบบสุ่มช่วง (Jittered TTL) 30–60 วินาที

**สิ่งที่ใช้:** `PRODUCT_CACHE_TTL_MIN_SECONDS=30`, `PRODUCT_CACHE_TTL_MAX_SECONDS=60`
แล้วสุ่มค่าจริงต่อคีย์

**ทำไม:** ถ้าใช้ TTL คงที่ คีย์ทุกหน้าที่ถูกสร้างในเวลาไล่เลี่ยกัน (ซึ่งเกิดแน่นอน เพราะ
version bump ทำให้ทุกหน้าถูก rebuild พร้อมกัน) จะ **หมดอายุพร้อมกันทั้งชุด** → เกิด
**cache avalanche** คือ request ของทุกหน้าพุ่งลง Postgres ในวินาทีเดียวกัน
การใส่ jitter กระจายเวลาหมดอายุออกไป ทำให้โหลดฝั่ง DB เรียบขึ้น

### 1.3 เลือกใช้: Rebuild Mutex (`SET NX PX`) แทนการปล่อยให้ทุกคนไป query เอง

**ปัญหาที่แก้: Cache Stampede / Thundering Herd** — ตอนคีย์ยังไม่มี (เพิ่ง bump version)
ถ้ามี 300 request มาถึงพร้อมกัน ทั้ง 300 จะเห็น miss แล้ววิ่งไป query Postgres พร้อมกัน
ทั้งที่คำตอบเหมือนกันเป๊ะ

**สิ่งที่ใช้:** คนที่ miss จะพยายามคว้า lock ก่อน

```
SET products:rebuild_lock:page:{page}:limit:{limit}:v:{version} <token> PX 5000 NX
```

- **คนที่ได้ lock** = คนเดียวที่ไป query Postgres แล้วเขียนผลลงคีย์ page → ตอบ `X-Cache: MISS`
- **คนที่ไม่ได้ lock** = **ไม่ query** แต่ **poll** คีย์ page ซ้ำ ๆ (`PRODUCT_CACHE_LOCK_RETRY_MAX`
  ครั้ง ห่างกัน `PRODUCT_CACHE_LOCK_RETRY_DELAY_MS`) พอผู้ถือ lock เขียนเสร็จก็อ่านได้ → `X-Cache: HIT`

**ทำไม lock key ต้องมี `:v:{version}` ด้วย:** ถ้าไม่มี คนที่รออยู่อาจได้ผลลัพธ์ของเวอร์ชันที่ตายไปแล้ว
และในโค้ดยังเช็คเพิ่มอีกชั้น — ถ้าระหว่าง poll แล้ว version ขยับ (มีคนสั่งซื้อสำเร็จพอดี)
จะ **เลิกรอทันที** แล้วอ่านตรงจาก DB เพราะสิ่งที่ผู้ถือ lock กำลังจะเขียนเป็นข้อมูลเก่าไปแล้ว

**ทำไมต้องใช้ token + ปล่อยด้วย Lua:** เหตุผลเดียวกับข้อ 2.5 ของ kao —
`DEL` เปล่า ๆ อาจไปลบ lock ของคนอื่นที่คว้าคีย์เดิมต่อจากเรา

**ผลที่วัดได้:** ยิง burst 300 requests พร้อมกันบนคีย์เย็น → Postgres ถูก query จริง **2 ครั้ง**

### 1.4 เลือกใช้: Lua script อ่าน version + page ใน round trip เดียว

**เดิม:** `GET version` แล้วค่อย `GET page` = 2 RTT ต่อ 1 request ซึ่งที่ 1,000 concurrent readers
คือ latency ที่เสียเปล่ามากที่สุดในเส้นทางนี้

**ตอนนี้:** `READ_PAGE_SCRIPT` (Lua) อ่าน version → ประกอบคีย์ page เอง → อ่าน page → คืนมาทีเดียว

ได้ของแถมคือ **atomicity** — version ขยับระหว่างสองคำสั่งไม่ได้อีกแล้ว
ดังนั้น page ที่ได้ **เป็นของ version ที่ได้เสมอ** และการประกอบคีย์อยู่ที่เดียวในระบบ
(ผู้เรียกเขียนกลับลงคีย์ที่ script คืนมา ไม่ประกอบเองซ้ำจนเสี่ยงไม่ตรงกัน)

> ข้อแลกเปลี่ยนที่รับไว้: script ประกอบ page key เองแทนที่จะประกาศใน `KEYS[]`
> ซึ่ง Redis เดี่ยวทำได้แต่ **Redis Cluster ทำไม่ได้** — ถ้าย้ายไป Cluster ต้องแยก
> การอ่าน version ออกมาเป็น KEYS อีกตัว และบังคับให้สองคีย์ hash ลง slot เดียวกัน

### 1.5 เลือกใช้: Single-flight ในกระบวนการ เป็นตาข่ายชั้นสุดท้าย

ถ้า Redis ล่ม / poll หมดโควตา / version ขยับกลางทาง → เข้าโหมด `BYPASS`
คืออ่านตรงจาก Postgres โดย **ไม่เขียน cache** (เพราะสิทธิ์เขียนยังเป็นของผู้ถือ lock)

แต่ถ้าทุกคน BYPASS พร้อมกัน ก็คือ stampede กลับมาอีก จึงมี `inFlight` Map ต่อ instance
รวม request ที่ `page:limit` เดียวกันให้เหลือ query เดียว
แปลว่าต่อให้ Redis ล่มทั้งตัว Postgres ก็รับแค่ (จำนวนหน้าที่ถูกถาม × 3 instance) ไม่ใช่ 1,000

### 1.6 เลือกใช้: แยก `BYPASS` ออกจาก `MISS` ไม่ยุบรวมกัน

- `MISS` = request นี้ **เติม cache ให้คนถัดไปเรียบร้อยแล้ว** → cache ทำงานปกติ แค่ยังเย็นอยู่
- `BYPASS` = อ่านทะลุไป DB **และไม่ได้เขียนอะไรเลย** → cache ไม่ได้มีส่วนร่วมด้วยซ้ำ

ความต่างนี้คือความต่างระหว่างคำว่า **"cold"** กับ **"พัง"** ถ้ายุบรวมกันจะแยกไม่ออก
ส่วนตัวเลข `cache:hits` / `cache:misses` เป็นยอดรวมทั้ง process ที่ทุก instance และทุก client
แชร์กัน จึงอธิบาย request เดี่ยว ๆ ไม่ได้ตอนมีโหลด — `X-Cache` จึงจำเป็น

และ endpoint นี้ตอบพร้อม `Cache-Control: no-store` เพื่อไม่ให้ proxy ไหนเอา response เก่า
ที่พก `X-Cache` เดิมมาเสิร์ฟซ้ำ จนตัวเลขที่วัดได้กลายเป็นเรื่องโกหก

### 1.7 เลือกใช้: clamp `page` และ snap `limit` — กัน Cache Penetration

`page` ถูก clamp ที่ **1000**, `limit` ถูกปัด **ขึ้น** ไปหาค่าใน `[10, 20, 50, 100]`

**ทำไม:** ทุกคู่ `page`/`limit` = คีย์ใหม่ใน Redis ถ้าปล่อยอิสระ ผู้โจมตี (หรือ script ที่เขียนพลาด)
ยิง `?page=999999999` ไล่ไปเรื่อย ๆ จะได้ **miss 100% ทุก request** เพราะไม่มีใครถามคีย์เดียวกัน
→ rebuild mutex ช่วยอะไรไม่ได้เลย (มีคนเดียวจะไป coalesce กับใคร) → ทุก request ลง Postgres ตรง ๆ
แถมทิ้งคีย์ขยะไว้ใน Redis เต็ม TTL ทำให้ Redis โตไม่มีขีดจำกัด

การจำกัดทำให้ key space = `1000 × 4` ซึ่งเป็นตัวเลขที่คำนวณได้ ไม่ใช่ช่วงเปิด
และ 1,000 หน้า × limit ใหญ่สุด ก็ยังมากกว่าแคตตาล็อกจริงเยอะ เพดานนี้จึงไม่มีใครชนในการใช้งานปกติ

**ทำไม clamp ไม่ใช่ reject:** load test นับ non-2xx เป็น failure (`http_req_failed: rate<0.01`)
และผู้เรียกก็ขอหน้าที่เกินแคตตาล็อกอยู่ดี การได้หน้าว่างกลับไปจึงเป็นคำตอบที่ซื่อสัตย์แล้ว
โดย `meta.page` รายงานค่าที่ clamp แล้ว ไม่ใช่ค่าที่พิมพ์มา

**ทำไม `limit` ปัดขึ้นไม่ใช่ปัดลง:** ผู้เรียกไม่ควรได้ข้อมูลน้อยกว่าที่ขอแบบเงียบ ๆ
ส่วนค่าที่ต่ำกว่า 1 หรือไม่ใช่ตัวเลข จะปล่อยผ่านไปให้ `@IsInt` / `@Min(1)` ปฏิเสธ —
ไม่ snap `0` หรือ `-5` ขึ้นเป็น 10 เพราะนั่นคือการยอมรับ request ที่ไร้เหตุผลแบบเงียบ ๆ

### 1.8 ข้อแลกเปลี่ยนที่ยอมรับ: hit rate ต่ำโดยตั้งใจ

ระหว่าง flash sale ทุก order ที่สำเร็จจะ bump version = ล้าง cache ทุกหน้าทันที
**ดังนั้น hit rate ต่ำเป็นเรื่องปกติและถูกต้อง** งานของโมดูลนี้ไม่ใช่การไล่ hit rate ให้สูง
แต่คือ **จำกัดจำนวน query ที่ลงถึง Postgres ต่อหนึ่ง version** ให้เหลือน้อยที่สุด
(ในอุดมคติคือ 1 query ต่อหนึ่งคู่ `page:limit` ที่มีคนใช้จริง)

ผลข้างเคียงที่รับไว้: `remainingStock` ในหน้าที่ cache ไว้อาจเก่าได้ชั่วครู่ เพราะมันถูกอบไว้ในก้อน JSON
ไม่ได้อ่านสด — ช่วงเวลาที่เก่าถูกจำกัดด้วย **เวลา rebuild ไม่ใช่ TTL** และความถูกต้องจริง ๆ
ยังไปตัดสินกันที่ตอนตัดสต็อกฝั่ง worker อยู่ดี

### 1.9 วิธีพิสูจน์

```bash
bash load-test/test-1-moo-cache.sh
```

ได้หลักฐาน 3 อย่างตรงตามที่รายงานต้องการ: (1) miss → hit → hit แบบ deterministic
พร้อมตัวเลข hit/miss, (2) latency ของ hit เทียบกับ miss, (3) ยิง burst พร้อมกันแล้วเทียบ
`seq_scan` ของตาราง `products` จาก `pg_stat_user_tables` ก่อน/หลัง เพื่อยืนยันว่า
Postgres ไม่ได้โดนถล่ม

---

## ส่วนที่ 2 — kao: Write Path ขาเข้า (Distributed Lock)

> โจทย์: ผู้ใช้คนเดียวกดปุ่มรัว ๆ 3 ครั้ง (หรือ client retry เอง) ต้องได้ order เดียว
> และต้องกันได้ **ข้าม API instance** เพราะ nginx กระจายไปคนละตัว

ไฟล์หลัก: [api/src/orders/orders.service.ts](api/src/orders/orders.service.ts)
· [api/src/orders/orders-lock.util.ts](api/src/orders/orders-lock.util.ts)
· [api/src/orders/orders-lock-release.listener.ts](api/src/orders/orders-lock-release.listener.ts)

### 2.1 เลือกใช้: `SET key value NX EX 30` — คำสั่งเดียว ไม่ใช่ check-then-set

```ts
const acquired = await this.redis.set(lockKey, payloadStr, 'EX', 30, 'NX');
```

โดย `lockKey` = `order-lock:{userId}:{productId}`

**ทำไมต้องเป็นคำสั่งเดียว:** ถ้าเขียนเป็น

```ts
if (!await redis.get(key)) {      // ← ช่องว่างตรงนี้
  await redis.set(key, value);    //   สอง request ผ่านพร้อมกันได้
}
```

นี่คือ **race condition แบบ check-then-act** สอง request ที่มาถึงพร้อมกันจะเห็น "ว่าง" ทั้งคู่
แล้วเขียนทับกันทั้งคู่ → ได้ 2 job

`SET ... NX` รวม **การตรวจสอบและการเขียนเป็นการกระทำเดียวที่แบ่งแยกไม่ได้** ฝั่ง Redis
และเพราะ Redis ประมวลผลคำสั่งแบบ single-threaded มันจึงเรียงลำดับสอง request นั้นให้เอง
→ **มีคนเดียวเท่านั้นที่ได้ `"OK"`** อีกคนได้ `nil` ไม่มีช่องให้ชนะทั้งคู่

**ทำไมต้องเป็น Redis ไม่ใช่ lock ในหน่วยความจำ:** ระบบมี API 3 instance หลัง nginx
lock ที่อยู่ใน process เดียว (เช่น `Map` หรือ mutex ของ Node) กันได้แค่ภายใน instance นั้น
สองคลิกที่ตกไป api1 กับ api2 จะผ่านทั้งคู่ — จึงต้องเป็น **distributed lock** ที่ทุก instance เห็นร่วมกัน

**ทำไมไม่ใช้ Redlock:** Redlock แก้ปัญหา lock ข้าม Redis หลาย node ที่เป็นอิสระต่อกัน
ระบบนี้มี Redis เดี่ยว และที่สำคัญกว่าคือ **ความถูกต้องสุดท้ายไม่ได้พึ่ง lock ตัวนี้** —
ต่อให้ lock พลาด ก็ยังมี `UNIQUE (user_id, product_id)` ที่ระดับฐานข้อมูลรับอยู่ (ดูส่วนของ Gus)
lock ตัวนี้ทำหน้าที่ "กันงานซ้ำไม่ให้ไปถึง DB" ไม่ใช่ "ผู้พิทักษ์ความถูกต้องคนสุดท้าย"
การลาก Redlock เข้ามาจึงเพิ่มความซับซ้อนโดยไม่ได้อะไรกลับมา

### 2.2 เลือกใช้: คนที่แพ้ได้ "คำตอบเดิม" ไม่ใช่ error (Idempotent Replay)

ค่าที่เก็บใน lock **ไม่ใช่แค่ flag** แต่เป็น response ทั้งก้อน:

```json
{ "orderJobId": "order:user-7:p-1001", "message": "Your order is in the queue." }
```

คนที่ `SET NX` แล้วได้ `nil` จะ `GET` ค่านั้นออกมา **แล้วตอบกลับไปเหมือนกับคนแรกเป๊ะ**

**ทำไม:** ถ้าตอบ `409 Conflict` ผู้ใช้ที่แค่กดสองครั้ง (หรือมือถือที่ retry เพราะเน็ตกระตุก)
จะเห็นว่าสั่งซื้อไม่สำเร็จ ทั้งที่จริง ๆ ออร์เดอร์เข้าคิวไปเรียบร้อยแล้ว
การตอบคำตอบเดิมทำให้ endpoint นี้ **idempotent** — เรียกกี่ครั้งผลลัพธ์เท่าเดิม
ซึ่งเป็นพฤติกรรมที่ client retry ได้อย่างปลอดภัย

### 2.3 เลือกใช้: `jobId` แบบ deterministic — ป้องกันชั้นที่สอง แบบไม่มีต้นทุนเพิ่ม

```ts
jobId = `order:${userId}:${productId}`
```

BullMQ **dedupe ตาม `jobId`** ให้อยู่แล้ว ถ้ามี job id ซ้ำเข้าคิว มันจะไม่สร้าง job ใหม่
ดังนั้นแม้ Redis lock จะพลาดในกรณีสุดวิสัย ก็ยังมีด่านนี้อีกชั้น — และไม่มีค่าใช้จ่ายเพิ่ม
เพราะยังไงก็ต้องตั้ง jobId อยู่แล้ว

`jobId` นี้ยังถูกเขียนลงคอลัมน์ `orders.job_id` ด้วย ซึ่ง Gus เอาไปใช้แยก
"replay หลัง crash" ออกจาก "ซื้อซ้ำจริง" (ดูข้อ 3.6)

การประกอบ lock key / job id / payload ถูกรวมไว้ใน `orders-lock.util.ts` ที่เดียว
เพราะฝั่งจอง (`OrdersService`) กับฝั่งปล่อย (`OrdersLockReleaseListener`) ต้องได้สตริงตรงกันเป๊ะ
ไม่งั้น compare-and-delete ในข้อ 2.5 จะพังแบบเงียบ ๆ

### 2.4 เลือกใช้: ปล่อย lock ตอน job จบ ไม่ใช่รอ TTL หมด

`OrdersLockReleaseListener` ฟัง BullMQ `QueueEvents` แล้วปล่อย lock ทันทีที่ job
`completed` **หรือ** `failed`

**ทำไมสำคัญ:** ถ้ารอแต่ TTL 30 วินาที ผู้ใช้ที่ order ล้มเหลว (เช่นระบบพลาดชั่วคราว)
จะ **กดใหม่ไม่ได้เลยเป็นเวลา 30 วินาที** ทั้งที่ควรลองใหม่ได้ทันที
TTL จึงเหลือบทบาทเป็นแค่ **ตาข่ายนิรภัย** เผื่อ listener ตัวนี้ล่ม

**ทำไม TTL = 30 วินาที:** สั้นเกินไป → job ที่ทำงานช้าแต่ปกติดี อาจโดน duplicate แซงเข้ามาก่อนจะเสร็จ
ยาวเกินไป → ถ้า listener ล่ม ผู้ใช้ติดล็อกนานเกินควร 30 วินาทีครอบคลุมเวลา enqueue + process
ในสภาวะปกติได้สบาย ๆ

**ทำไม release ต้องอยู่ที่ listener ที่เดียว:** ก่อนหน้านี้เคยปล่อยจาก processor ด้วย
แต่ประกอบคีย์ผิด ทำให้มันไม่เคยทำงานจริงและไม่มีใครรู้ ตอนนี้ listener เป็นเจ้าของคีย์นี้คนเดียว

### 2.5 เลือกใช้: Compare-and-Delete ด้วย Lua ไม่ใช่ `DEL` เปล่า ๆ

```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
```

**ทำไม:** สมมติ lock ของ A หมดอายุไปก่อน แล้ว B คว้า lock คีย์เดิมได้ พอ job ของ A จบช้า ๆ
แล้วสั่ง `DEL` เปล่า → **มันจะไปลบ lock ที่ยังมีชีวิตของ B** ทำให้ B โดนแซงได้

สคริปต์นี้จึงเทียบ token ก่อนลบ และเพราะ Lua script ใน Redis รันเป็นหน่วย atomic
การเทียบกับการลบจึงไม่มีช่องว่างระหว่างกลาง (ถ้าเขียนเป็น GET แล้วค่อย DEL = 2 RTT
ก็มีช่องว่างตรงกลางเหมือนเดิม)

รูปแบบเดียวกันนี้ถูกใช้ซ้ำที่ `RELEASE_LOCK_SCRIPT` ของ rebuild mutex ฝั่ง cache ด้วย

### 2.6 เลือกใช้: retry 3 ครั้ง เพื่อปิดช่อง TOCTOU ที่ขอบ TTL

มีกรณีหายากมาก: `SET NX` ล้มเหลว แต่พอ `GET` กลับได้ `nil` เพราะ lock หมดอายุพอดี
ในเสี้ยววินาทีระหว่างสองคำสั่ง โค้ดจะวนกลับไปพยายามใหม่ (จำกัดที่ `MAX_ACQUIRE_ATTEMPTS = 3`
เพื่อไม่ให้วนไม่รู้จบ) ถ้ายังไม่ได้จริง ๆ จะ enqueue ตรง ๆ ไปเลย — แย่สุดคือ job id ซ้ำ
ซึ่ง BullMQ dedupe ให้อยู่แล้ว ยังดีกว่าปล่อย request ค้างไม่มีคำตอบ

และถ้า `queue.add()` โยน error ออกมา จะ **ปล่อย lock ทิ้งทันที** ด้วย compare-and-delete
เพราะไม่มี job อยู่ในคิวให้ listener ปล่อยให้ในภายหลัง — ผู้ใช้จะได้ไม่ต้องรอ TTL ฟรี ๆ

### 2.7 วิธีพิสูจน์

```bash
bash load-test/test-2-kao-lock.sh
```

พิสูจน์ 3 ข้อ: (1) กด N ครั้งพร้อมกันจากผู้ใช้เดียวกัน → เหลือ **1 job**,
(2) `ZCARD bull:orders:completed` ขยับแค่ 1 ไม่ใช่ N,
(3) ยิงซ้ำด้วยผู้ใช้คนที่สองทันที เพื่อยืนยันว่า lock **ผูกกับ user+product** ไม่ใช่ล็อกทั้งระบบ

---

## ส่วนที่ 3 — Gus: Write Path ขาประมวลผล (DB Transaction & Throughput)

> โจทย์: 500 คนแย่งของ 50 ชิ้นบน row เดียวกัน สต็อกต้องลงเอยที่ **0 พอดี** ห้ามติดลบ
> ห้ามมีใครได้เกิน 1 ชิ้น และต้องวัด throughput ได้

ไฟล์หลัก: [api/src/orders/stock-claim.service.ts](api/src/orders/stock-claim.service.ts)
· [api/src/orders/orders.processor.ts](api/src/orders/orders.processor.ts)

### 3.1 เลือกใช้: ตัดสต็อก + สร้าง order ใน transaction เดียว

ถ้าแยกเป็นสองคำสั่งแล้วพังตรงกลาง จะได้สต็อกที่ถูกหักไปแล้วแต่ไม่มี order —
ของหายจากระบบโดยไม่มีใครได้ไป การอยู่ใน transaction เดียวแปลว่า
**ถ้า INSERT ล้มเพราะ unique constraint การหักสต็อกจะ rollback ตามไปด้วย
และของชิ้นนั้นกลับคืนสู่กองโดยอัตโนมัติ**

### 3.2 เลือกใช้: Isolation Level = `READ COMMITTED` (ไม่ยกไป `SERIALIZABLE`)

**ทำไมไม่ต้องสูงกว่านี้:** `SELECT ... FOR UPDATE` **เป็นจุด serialize ในตัวมันเองอยู่แล้ว** —
transaction ที่สองจะถูกบล็อกจนตัวแรก commit แล้วจึงอ่านค่าที่ตัวแรกทิ้งไว้ ไม่ใช่ค่าเก่า
การขึ้นไป `SERIALIZABLE` จะได้มาแค่ serialization failure (`40001`) ที่ต้อง retry เพิ่ม
โดยไม่ได้ความถูกต้องเพิ่มขึ้นเลยในทรงงานแบบนี้

### 3.3 สามกลยุทธ์ที่ implement ไว้ให้สลับได้ตอน runtime

เลือกผ่าน `STOCK_CLAIM_STRATEGY` โดย worker อ่านจาก environment
→ benchmark sweep แค่ restart container ไม่ต้อง rebuild image

| Strategy | ทำอย่างไร | ข้อดี / ข้อเสีย |
|---|---|---|
| **`pessimistic`** (default, ตัวที่ใช้จริง) | `SELECT ... FOR UPDATE` แล้วค่อย `UPDATE` + `INSERT` | อ่านโค้ดเข้าใจง่ายที่สุด แต่เสีย **3 round trips ขณะที่ยังถือ row lock อยู่** |
| **`optimistic`** (ทำไว้เพื่อวัดเทียบ ไม่ได้ใช้จริง) | คอลัมน์ `version` + compare-and-swap + retry (สูงสุด 50 ครั้ง) | ไม่ล็อก row แต่พอ 500 คนชน row เดียวกัน retry จะตีกันเละ งานที่เสียเปล่าสูงมาก |
| **`atomic`** | CTE เดียว: `UPDATE ... RETURNING` + `INSERT ... SELECT` | **1 round trip ขณะถือ lock** เร็วที่สุดเท่าที่วัดได้ |

**ข้อสังเกตสำคัญที่ขับการออกแบบทั้งหมดนี้:** ทุก request ในการทดสอบชี้ไป **row เดียวกัน 100%**
ภายใต้ทรงงานแบบนี้ PostgreSQL จะบังคับให้ writer เข้าแถวที่ row lock อยู่ดีไม่ว่าจะทำอย่างไร
**ตัวแปรเดียวที่ขยับ throughput ได้จริงจึงคือ "อยู่ในล็อกนานแค่ไหน"** ไม่ใช่ "ล็อกหรือไม่ล็อก"
นั่นคือเหตุผลว่าทำไม `atomic` ถึงชนะ และทำไม `optimistic` ถึงแพ้ทั้งที่ "ไม่ล็อก"

**ทำไม default ยังเป็น `pessimistic`:** อ่านง่าย ตรวจสอบง่าย และให้ correctness เท่ากันทุกประการ
`atomic` เป็นตัวเลือกไว้ตอนต้องการ throughput สูงสุด

ใน `atomic` การ `INSERT` ถูกขับด้วย `SELECT ... FROM claimed` ดังนั้นถ้า `UPDATE` ไม่โดนแถวไหน
(สต็อกหมด) `claimed` จะว่าง → `INSERT` ไม่เขียนอะไร → ทั้ง statement คืน 0 แถว
และเพราะ 0 แถวยังกำกวม (หมดสต็อก หรือไม่มีสินค้านี้?) จึงมี query ตามไปเช็คให้แน่
เพื่อให้เหตุผลความล้มเหลวที่ขึ้นใน Bull Board เป็นความจริง

> `optimistic` มีตัวนับ `attempts` / `successes` เก็บไว้ให้ด้วย เพื่อรายงาน
> **wasted work = attempts − successes** เป็นหลักฐานเชิงตัวเลขว่ามันแพ้เพราะอะไร
> และคอลัมน์ `version` จงใจเป็น `int` ธรรมดา **ไม่ใช่ `@VersionColumn` ของ TypeORM**
> เพราะ `@VersionColumn` จะบังคับ optimistic locking กับ `save()` ทุกที่ รวมถึง seeder ด้วย
> ทั้งที่เราต้องการให้มันมีผลเฉพาะกับกลยุทธ์ที่ร้องขอเท่านั้น

### 3.4 เลือกใช้: `lock_timeout = 5s` แบบ `SET LOCAL` — ล้มให้เห็น ดีกว่าค้างเงียบ ๆ

```sql
SET LOCAL lock_timeout = '5s'
```

**ทำไมต้องมี:** ถ้าไม่ตั้ง transaction จะรอ row lock **ไปเรื่อย ๆ ไม่มีที่สิ้นสุด**
คิวจะบวมขึ้นโดยไม่มีสัญญาณอะไรเตือน จนกระทั่งระบบตายทั้งระบบ

**ทำไมต้อง `SET LOCAL`:** จำกัดผลไว้แค่ transaction ปัจจุบัน **ไม่รั่วไปหาคนถัดไป**
ที่หยิบ connection เดิมจาก pool ไปใช้

Postgres จะคืน error `55P03` ซึ่งถูกจัดเป็น transient → BullMQ retry ให้
**คิวที่ล้มแบบมองเห็นได้ ดีกว่าคิวที่โตขึ้นเงียบ ๆ**

ค่านี้ถูก validate ด้วย regex ก่อนใช้ (และ fallback เป็น `5s` ถ้าผิดรูปแบบ)
เพราะมันถูก interpolate ลง SQL ตรง ๆ — `SET LOCAL` รับ bind parameter ไม่ได้

### 3.5 เลือกใช้: `DB_POOL_MAX = WORKER_CONCURRENCY + 2`

**ทำไม:** ถ้า pool เล็กกว่า concurrency, job จะไป **เข้าแถวรอ connection ตั้งแต่ยังไม่ถึง row lock ด้วยซ้ำ**
ทำให้ตัวเลข concurrency ที่ตั้งไว้เป็นเรื่องหลอก และการ tune จะสรุปผลผิด
บวก 2 ไว้เผื่อ query นอกเส้นทางหลัก เช่น `classifyUniqueViolation` ที่ต้องใช้ connection คนละตัว

### 3.6 ป้องกันความถูกต้องหลายชั้น — ไม่พึ่งชั้นใดชั้นเดียว

| ชั้น | กลไก | กันอะไร |
|---|---|---|
| Redis | `SET NX EX` (ส่วนของ kao) | คลิกซ้ำ / client retry ก่อนไปถึง DB |
| BullMQ | dedupe ตาม `jobId` | job ซ้ำเข้าคิว |
| Postgres | `UNIQUE (user_id, product_id)` | ซื้อซ้ำ — **ด่านสุดท้ายที่หลบไม่ได้** |
| Postgres | `CHECK (remaining_stock >= 0)` | สต็อกติดลบ แม้ logic จะพลาด |
| App | `SELECT ... FOR UPDATE` / CTE | oversell จาก race condition |

**การอ่าน `23505` (unique violation) ให้ถูกความหมาย:** เมื่อชน constraint ระบบจะไปดูว่า
row ที่มีอยู่พก `job_id` เดียวกับ job ที่กำลังรันอยู่หรือไม่

- `job_id` ตรงกัน → **job นี้ commit ไปแล้วในรอบก่อน แล้ว crash ก่อน BullMQ จะบันทึกผล**
  = replay ไม่ใช่ความผิดพลาด → รายงานว่า **สำเร็จ**
- `job_id` ต่างกัน → เป็นการซื้อซ้ำจริง → `DuplicateOrderError`

การเช็คนี้ **ต้องรันบน connection คนละตัว** เพราะเมื่อ statement ใน transaction ล้มแล้ว
Postgres จะ "วางยา" transaction นั้น — ทุก query ถัดไปคืน `25P02` จนกว่าจะ rollback
แถวที่ต้องไปดูจึงเอื้อมไม่ถึงจาก transaction ที่เพิ่งระเบิด

และกรณี replay จะ **throw `ReplayDetectedError` ไม่ใช่ return ผลลัพธ์** เพื่อให้ transaction
rollback ก่อน แล้วค่อยให้ processor แปลงเป็น success — ถ้า return เฉย ๆ การหักสต็อกของรอบนี้
จะถูก commit ทับของรอบเดิม = **ขายของชิ้นเดียวสองรอบ**

> `@Index(['productId'])` บนตาราง `orders` **ไม่ใช่** การ optimize เส้นทางร้อน และไม่ควรอ้างแบบนั้น
> การหักสต็อกหาแถวใน `products` ด้วย primary key และไม่แตะ index ของตารางนี้เลย
> สิ่งที่มันช่วยคือ query สรุปรายสินค้าตอนตรวจผล ("p-1001 มีกี่ order?") ซึ่ง composite index
> `(user_id, product_id)` ทำแทนไม่ได้เพราะ `product_id` เป็นคอลัมน์ท้าย

### 3.7 เลือกใช้: bump cache version **หลัง** commit เท่านั้น

`orders.processor.ts` จะ `INCR` cache version หลัง transaction commit สำเร็จแล้วเท่านั้น

**ทำไมลำดับนี้สำคัญ:** ถ้า bump ก่อน commit เท่ากับสั่งให้ reader ทิ้ง cache
บนพื้นฐานของ write ที่ยัง rollback ได้ และแย่กว่านั้นคือ reader อาจเข้าไป rebuild cache
จากสถานะ **ก่อน** commit แล้วทิ้งค่าเก่านั้นไว้ **ยืนยาวกว่าตัว transaction เอง**

และถ้า `INCR` ล้มเหลว **ห้ามทำให้ job ล้ม** เพราะสต็อกถูกตัดถูกต้องไปแล้ว
reader จะตกกลับไปพึ่ง TTL แทน (นี่คืออีกเหตุผลว่าทำไม TTL ถึงต้องมีอยู่)

worker กับ reader ยัง resolve `CACHE_VERSION_KEY` ผ่าน helper ตัวเดียวกัน (`cache-keys.ts`)
เพราะถ้าสองฝั่งใช้คีย์คนละตัว การ invalidate จะพังโดยไม่มี error ให้เห็นเลยสักบรรทัด

### 3.8 การจัดหมวดหมู่ความล้มเหลว

`err.name` พก taxonomy ไปด้วย (`OUT_OF_STOCK`, `DUPLICATE_ORDER`, `LOCK_TIMEOUT`, …)
ทำให้ Bull Board แสดง **สาเหตุ** ไม่ใช่กำแพงสีแดงก้อนเดียว — การแจกแจงนี้คือหลักฐานหลัก
ในรายงาน เพราะในสถานการณ์ 500 คนแย่ง 50 ชิ้น **`OUT_OF_STOCK` 450 รายการคือผลลัพธ์ที่ถูกต้อง**
ส่วนความล้มเหลวชนิดอื่นบนรอบนั้นคือบั๊ก

### 3.9 วิธีพิสูจน์

```bash
bash load-test/test-3-gus-throughput.sh
```

ได้: (1) `remaining_stock` = 0 พอดี ไม่ติดลบ, (2) `orders` มี 50 แถว จาก 50 users ไม่ซ้ำ,
(3) sold == consumed ส่วนต่าง 0 (atomicity cross-check), (4) throughput / p50 / p95 /
การแจกแจงความล้มเหลว พร้อม append ลง `bench-results.csv`

เทียบกลยุทธ์แบบเป็นระบบ (สคริปต์จะ restart worker ให้ทุกค่าคอนฟิก):

```bash
bash load-test/sweep.sh strategy      # pessimistic vs optimistic vs atomic
bash load-test/sweep.sh concurrency   # 1,2,4,8,16,32
```

---

## Infrastructure: Nginx + Load Balancing

ไฟล์: [nginx/nginx.conf](nginx/nginx.conf)

### เลือกใช้: `least_conn` (Least Connections) ไม่ใช่ round-robin หรือ ip_hash

```nginx
upstream backend {
  least_conn;
  server api1:3000 max_fails=5 fail_timeout=5s;
  ...
}
```

**Least Connections คืออะไร:** nginx ส่ง request ใหม่ไปยัง upstream ที่มี
**จำนวน connection ที่ยังทำงานค้างอยู่น้อยที่สุด ณ ขณะนั้น**

**ทำไมเลือกอันนี้:**

| อัลกอริทึม | พฤติกรรม | เหมาะกับระบบนี้ไหม |
|---|---|---|
| `round_robin` (ค่า default) | แจกวนไปทีละตัวเท่า ๆ กัน โดย **ไม่สนว่าตัวไหนงานล้นอยู่** | ❌ request ในระบบนี้ใช้เวลาไม่เท่ากันมาก — cache `HIT` จบในไม่กี่ ms แต่ `MISS` ต้องรอ query Postgres ส่วน `POST /orders` ต้องรอ Redis + enqueue ถ้าแจกวนเฉย ๆ instance ที่บังเอิญได้งานหนักติดกันจะมีคิวยาวขึ้นเรื่อย ๆ ขณะที่อีกสองตัวว่าง |
| `ip_hash` | ผูก client IP กับ instance เดิมเสมอ (sticky) | ❌ ระบบนี้ **stateless ด้วย JWT** ไม่มี session ให้ต้องผูก และ k6 ยิงจาก IP เดียว → โหลด **ทั้งหมด** จะตกที่ instance เดียว อีกสองตัวว่างสนิท เท่ากับไม่ได้ทำ load balancing เลย |
| **`least_conn`** | ดูภาระจริงที่ค้างอยู่ แล้วส่งไปตัวที่ว่างที่สุด | ✅ **เลือกอันนี้** — สะท้อนภาระจริงตามเวลา และเข้ากับการที่ latency ของ request กระจายตัวสูง |

> เงื่อนไขที่ทำให้เลือกแบบนี้ได้: API เป็น **stateless** สมบูรณ์ (auth ด้วย JWT ล้วน
> ไม่มี session ฝั่ง server, state ร่วมทุกอย่างอยู่ใน Redis/Postgres)
> request ไหนไปตกที่ instance ใดก็ให้ผลเหมือนกัน
> ถ้าเก็บ session ไว้ในหน่วยความจำของ API เราจะถูกบังคับให้ใช้ `ip_hash`
> และเสียความสามารถในการ balance ตามภาระจริงไป

### ค่า tuning อื่น ๆ ที่จำเป็นจริง (ทุกบรรทัดมีเหตุผล)

| ค่า | ตั้งเป็น | ทำไม |
|---|---|---|
| `worker_processes` | `auto` | default = 1 ซึ่ง process เดียวใช้ CPU หลายคอร์ไม่หมดภายใต้โหลดระดับนี้ |
| `worker_connections` | `4096` | default 512 และเป็นเพดาน **ต่อ worker** ที่นับ **ทั้งสองฝั่ง** ของ proxied request → ของเดิมตันที่ราว 256 concurrent เท่านั้น แต่แค่ write test เปิดพร้อมกัน 540 connection ทำให้ request ล้มระดับ connection (k6 รายงานเป็น status 0 ไม่ใช่ HTTP error) |
| `worker_rlimit_nofile` | `16384` | ใช้ 2 file descriptor ต่อ 1 proxied request (ฝั่ง client + ฝั่ง upstream) บวกเผื่อ |
| `max_fails` / `fail_timeout` | `5` / `5s` | default คือ `1` / `10s` — สะดุดครั้งเดียว upstream โดนถีบออก 10 วินาที พอ burst มาทีเดียวโดนถีบทั้ง 3 ตัวพร้อมกัน nginx ตอบ `502 no live upstreams` ให้ทุก request (เจอจริงใน log) จึงเปลี่ยนเป็น "ต้องพลาดหลายครั้งถึงถีบ และให้อภัยเร็ว" |
| `keepalive` / `keepalive_requests` | `128` / `1000` | ใช้ connection เดิมซ้ำ แทนการ TCP handshake ใหม่ทุก request (และแทนที่จะทิ้ง socket ค้างสถานะ TIME_WAIT) |
| `proxy_http_version 1.1` + `proxy_set_header Connection ""` | — | **ต้องมีทั้งสองบรรทัด** upstream keepalive ถึงจะทำงานจริง: ต้องเป็น HTTP/1.1 และต้องเคลียร์ header `Connection` ไม่ให้ `Connection: close` ถูกส่งต่อไปยัง upstream |
| `listen 80 backlog=4096` | — | รองรับ connection ที่มารอ accept พร้อมกันเป็นพัน |
| `access_log ... buffer=32k flush=5s` | — | เขียน log แบบ buffer แทนการเขียนแบบ blocking ทุก request |

---

## Load testing

ทุกอย่างอยู่ใน `load-test/` ดูรายละเอียดครบใน **[load-test/RUNBOOK.md](load-test/RUNBOOK.md)**

```bash
bash load-test/reset.sh                  # ต้องรันก่อนทุกครั้งที่จะวัดผล

bash load-test/test-1-moo-cache.sh       # read path: hit/miss, latency, ไม่มี stampede
bash load-test/test-2-kao-lock.sh        # entry lock: N clicks -> 1 job
bash load-test/test-3-gus-throughput.sh  # worker: integrity + throughput
bash load-test/test-4-full-system.sh     # ทั้งสามส่วนพร้อมกัน
```

**รัน k6 จากในเครือข่าย compose:**

```bash
docker compose --profile loadtest run --rm k6 /scripts/<script>.js
```

อย่ารันจาก host — การเปิด 500+ connection พร้อมกันจาก host จะโดน Docker Desktop
port forwarder ปฏิเสธไปส่วนหนึ่ง (ราว 20%) ซึ่งจะโผล่เป็น failure ที่เป็นความผิดของ
**เครื่องมือทดสอบ ไม่ใช่ของระบบ** นี่คือเหตุผลที่ `BASE_URL` default เป็นชื่อ service
ไม่ใช่ `localhost:8080`

**ทำไม `reset.sh` สำคัญ:** `measure.js` คำนวณ throughput จากช่วงเวลา
`min(processedOn)` ถึง `max(finishedOn)` ของ job ทุกตัวที่ยังอยู่ในคิว
ถ้ามี job ค้างจากรอบก่อน หน้าต่างเวลาจะถูกยืดออก ทำให้ throughput ที่รายงาน **ต่ำกว่าความจริง**

ความถูกต้องพิสูจน์กันที่ฐานข้อมูล ไม่ใช่ที่ HTTP status code:

```bash
docker compose exec -T postgres psql -U postgres -d flash_sale < load-test/verify.sql
```

ผลที่ต้องได้หลัง `orders-500.js`:

| สิ่งที่ตรวจ | ค่าที่ถูกต้อง |
|---|---|
| `remaining_stock` ของ `p-1001` | `0` เป๊ะ |
| orders / distinct users | `50` / `50` |
| คนที่มี order มากกว่า 1 | 0 แถว |
| ส่วนต่าง consumed vs sold | `0` |
| failure จาก `measure.js` | `OUT_OF_STOCK` 450 รายการ, `retried 0` |

> **ทำไมต้องมี `lost-jobs-check.js`:** สถานการณ์ตาม spec **แยกไม่ออก** ระหว่าง
> "ขายหมดอย่างถูกต้อง" กับ "job หายไปเงียบ ๆ" เพราะยังไง 450 คนก็ต้องแพ้อยู่แล้ว
> สคริปต์นี้จึงใช้ `p-1003` ที่มี 500 ชิ้น กับผู้ใช้ 500 คน — ผลลัพธ์ที่ถูกต้องมีทางเดียวคือ
> **500 orders และสต็อกเหลือ 0** ขาดไปแม้แต่ชิ้นเดียว = job หาย ไม่ใช่ของหมด

---

## Configuration

ตัวแปรทั้งหมดอยู่ใน `.env` (ดู `.env.example`) ตัวที่สำคัญ:

| Variable | Default | ทำอะไร |
|---|---|---|
| `STOCK_CLAIM_STRATEGY` | `pessimistic` | worker ใช้กลยุทธ์ล็อกแบบไหน (`pessimistic` / `optimistic` / `atomic`) |
| `WORKER_CONCURRENCY` | `10` | จำนวน job ที่ทำพร้อมกันต่อ worker หนึ่งตัว |
| `DB_POOL_MAX` | `concurrency + 2` | pool ต้องมากกว่า concurrency ไม่งั้น job ไปรอ connection ตั้งแต่ยังไม่ถึง row lock |
| `DB_LOCK_TIMEOUT` | `5s` | ล้มเร็ว (ได้ `55P03` ที่ retry ได้) แทนที่จะสะสม backlog ที่มองไม่เห็น |
| `PRODUCT_CACHE_TTL_MIN/MAX_SECONDS` | `30` / `60` | TTL แบบสุ่มช่วง ไม่ให้คีย์หมดอายุพร้อมกัน |
| `PRODUCT_CACHE_LOCK_TTL_SECONDS` | `5` | ผู้ถือ rebuild lock ถือได้นานแค่ไหนขณะ query + เติม cache |
| `PRODUCT_CACHE_LOCK_RETRY_MAX` / `_DELAY_MS` | `5` / `50` | คนที่แพ้ lock poll กี่ครั้ง ห่างกันเท่าไร ก่อนยอมแพ้แล้วอ่านตรงจาก DB |
| `CACHE_VERSION_KEY` | `products:cache:version` | คีย์ counter — **worker ต้อง bump คีย์นี้เป๊ะ ๆ** ไม่งั้นการ invalidate พังแบบเงียบ ๆ (จึง resolve ผ่าน helper ตัวเดียวกันทั้งสองฝั่ง) |

service `worker` และ `api*` ประกาศตัวแปรเหล่านี้ไว้ใน `docker-compose.yml` ด้วย
ไม่ใช่แค่ใน `.env` เพราะ `environment` ชนะ `env_file` → benchmark sweep override ได้ทีละรอบ
โดยไม่ต้องแก้ไฟล์และไม่ต้อง rebuild:

```bash
WORKER_CONCURRENCY=4 docker compose up -d --force-recreate --no-deps worker
```

---

## ข้อจำกัดที่รู้ตัว (Known limitations)

- **`synchronize: true` ยังเปิดอยู่** ใน `api/src/config/typeorm.config.ts`
  มันคือสิ่งที่สร้าง schema ให้บน volume ใหม่ ทำให้เริ่มระบบได้ในคำสั่งเดียว
  ของจริงต้องเปลี่ยนเป็น migrations — มี TODO กำกับไว้ในไฟล์นั้นแล้ว
- **`POST /api/v1/auth/token` ออก token ให้ `userId` อะไรก็ได้** ยังไม่มีการตรวจรหัสผ่าน
  เพราะ spec ของงานนี้ไม่ได้กำหนด user storage — มี TODO กำกับไว้ใน `auth.service.ts`
- **ภายใต้โหลด read + write พร้อมกัน tail latency แตะระดับหลายวินาที** แม้ p95 จะยังต่ำกว่า 600 ms
- **throughput ไม่ดีขึ้นอีกเมื่อเกิน `WORKER_CONCURRENCY=4`** เพราะทุก order แย่ง
  product row เดียวกัน การเพิ่ม concurrency จึงซื้อได้แค่ "คิวที่ยาวขึ้น" ไม่ใช่ "ความเร็ว"
  (สอดคล้องกับข้อสังเกตในข้อ 3.3 — ตัวแปรที่ขยับ throughput คือเวลาที่อยู่ในล็อก ไม่ใช่จำนวน worker)
- **การ invalidate cache เกิดจากการเปลี่ยนสต็อกเท่านั้น** การแก้ชื่อ/ราคา หรือ toggle
  `isFlashSaleActive` ไม่ bump version เพราะสมมติว่าชุดข้อมูลนิ่งระหว่างการทดสอบ
  ถ้าเลิกเป็นจริงเมื่อไร เส้นทางเหล่านั้นต้องเรียก `invalidateProductCache()` เอง
- **ไม่มี endpoint สำหรับ reset stats** — ใช้ `load-test/reset.sh` ล้าง `cache:hits`/`cache:misses`
  ระหว่างรอบทดสอบแทน
- **Lua script ฝั่ง cache ผูกกับ Redis แบบ standalone** ย้ายไป Redis Cluster ต้องแก้ (ดูข้อ 1.4)
