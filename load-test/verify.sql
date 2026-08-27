-- Data Integrity Proof. Run after the queue has fully drained.
--
--   docker compose exec -T postgres psql -U postgres -d flash_sale < load-test/verify.sql

\echo ''
\echo '=== 1) stock landed on zero, never below ==='
\echo '    expect: total_stock 50 | remaining_stock 0'
SELECT id AS product_id, total_stock, remaining_stock
  FROM products
 WHERE id = 'p-1001';

\echo ''
\echo '=== 2) exactly 50 orders from 50 different users ==='
\echo '    expect: 50 | 50'
SELECT count(*) AS orders, count(DISTINCT user_id) AS unique_users
  FROM orders
 WHERE product_id = 'p-1001';

\echo ''
\echo '=== 3) nobody holds more than one unit ==='
\echo '    expect: 0 rows'
\echo '    (strictly stronger than query 2: one user with 2 orders and another'
\echo '     with 0 still totals 50, so query 2 alone would not catch it)'
SELECT user_id, count(*) AS units
  FROM orders
 WHERE product_id = 'p-1001'
 GROUP BY user_id
HAVING count(*) > 1;

\echo ''
\echo '=== 4) atomicity cross-check: units sold == units gone from stock ==='
\echo '    expect: sold == consumed, drift 0'
SELECT p.id AS product_id,
       (p.total_stock - p.remaining_stock) AS consumed,
       (SELECT count(*) FROM orders o WHERE o.product_id = p.id) AS sold,
       (p.total_stock - p.remaining_stock)
         - (SELECT count(*) FROM orders o WHERE o.product_id = p.id) AS drift
  FROM products p
 WHERE p.id = 'p-1001';

\echo ''
\echo '=== 5) access paths on the hot queries ==='
\echo '    products lookup: expect Seq Scan here and DO NOT "fix" it.'
\echo '    The seed holds 20 rows, which fit in a single page, so the planner'
\echo '    correctly judges a scan cheaper than descending the index — note'
\echo '    the sub-millisecond Execution Time. It switches to an Index Scan on'
\echo '    products_pkey once the table is large enough to be worth it.'
EXPLAIN (ANALYZE, BUFFERS)
SELECT remaining_stock FROM products WHERE id = 'p-1001' FOR UPDATE;

\echo ''
\echo '    orders lookup: expect Index Scan on the UNIQUE(user_id, product_id)'
\echo '    index. This one has to be an index scan — it is the duplicate check,'
\echo '    and it runs on a table that grows with every order.'
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM orders WHERE user_id = 'user-1' AND product_id = 'p-1001';

\echo ''
\echo '=== bonus) no product anywhere went negative ==='
\echo '    expect: 0 rows'
SELECT id, remaining_stock FROM products WHERE remaining_stock < 0;
