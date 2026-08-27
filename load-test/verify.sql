-- Data Integrity Proof (spec section 3).
-- Run after the write load has finished AND the queue has fully drained.
--
--   docker compose exec postgres psql -U postgres -d flash_sale -f /dev/stdin < load-test/verify.sql
-- or paste the queries individually.

\echo '=== 1) remaining_stock must be exactly 0, never negative ==='
SELECT id, total_stock, remaining_stock
FROM products
WHERE id = 'p-1001';

\echo '=== 2) exactly 50 orders, all from different users ==='
SELECT count(*)              AS orders,
       count(DISTINCT user_id) AS unique_users
FROM orders
WHERE product_id = 'p-1001';

\echo '=== 3) nobody bought more than once (must return 0 rows) ==='
SELECT user_id, count(*) AS times
FROM orders
WHERE product_id = 'p-1001'
GROUP BY user_id
HAVING count(*) > 1;

\echo '=== 4) no product anywhere went negative (must return 0 rows) ==='
SELECT id, remaining_stock
FROM products
WHERE remaining_stock < 0;

\echo '=== 5) sanity: sold + remaining == original total ==='
SELECT p.id,
       p.total_stock,
       p.remaining_stock,
       (SELECT count(*) FROM orders o WHERE o.product_id = p.id) AS sold,
       p.remaining_stock + (SELECT count(*) FROM orders o WHERE o.product_id = p.id) AS should_equal_total
FROM products p
WHERE p.id = 'p-1001';
