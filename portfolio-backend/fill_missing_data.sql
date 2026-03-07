-- 填充缺失的钱包数据
-- 对于每个不完整的时间点，找出缺失的钱包，用该钱包之前最近的数据填充

-- 创建临时表存储所有时间点
CREATE TEMPORARY TABLE all_timestamps AS
SELECT DISTINCT DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:00') as ts_minute
FROM portfolio_snapshots;

-- 创建临时表存储所有钱包地址
CREATE TEMPORARY TABLE all_wallets AS
SELECT DISTINCT proxy_address FROM portfolio_snapshots;

-- 找出所有缺失的组合并插入
INSERT INTO portfolio_snapshots (timestamp, proxy_address, portfolio_total, usdc_balance, positions_value)
SELECT 
    t.ts_minute as timestamp,
    w.proxy_address,
    COALESCE(
        (SELECT portfolio_total FROM portfolio_snapshots 
         WHERE proxy_address = w.proxy_address AND timestamp < t.ts_minute 
         ORDER BY timestamp DESC LIMIT 1),
        0
    ) as portfolio_total,
    COALESCE(
        (SELECT usdc_balance FROM portfolio_snapshots 
         WHERE proxy_address = w.proxy_address AND timestamp < t.ts_minute 
         ORDER BY timestamp DESC LIMIT 1),
        0
    ) as usdc_balance,
    COALESCE(
        (SELECT positions_value FROM portfolio_snapshots 
         WHERE proxy_address = w.proxy_address AND timestamp < t.ts_minute 
         ORDER BY timestamp DESC LIMIT 1),
        0
    ) as positions_value
FROM all_timestamps t
CROSS JOIN all_wallets w
WHERE NOT EXISTS (
    SELECT 1 FROM portfolio_snapshots ps 
    WHERE DATE_FORMAT(ps.timestamp, '%Y-%m-%d %H:%i:00') = t.ts_minute 
    AND ps.proxy_address = w.proxy_address
)
AND EXISTS (
    SELECT 1 FROM portfolio_snapshots 
    WHERE proxy_address = w.proxy_address AND timestamp < t.ts_minute
);

-- 清理临时表
DROP TEMPORARY TABLE all_timestamps;
DROP TEMPORARY TABLE all_wallets;
