CREATE TABLE orders (
    id BIGINT NOT NULL PRIMARY KEY,
    category VARCHAR NOT NULL,
    amount BIGINT NOT NULL
);

CREATE MATERIALIZED VIEW totals AS
SELECT category, COUNT(*) AS items, SUM(amount) AS total
FROM orders
GROUP BY category;
