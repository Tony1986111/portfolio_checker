-- 修复过去一天内 USDC 为 0 的记录
-- 用该记录之前最近的非零 USDC 数据填充

-- 创建临时表存储需要更新的记录及其应该填充的值
CREATE TEMPORARY TABLE temp_fix AS
SELECT 
    ps.id,
    ps.proxy_address,
    ps.timestamp,
    (
        SELECT usdc_balance 
        FROM portfolio_snapshots ps2 
        WHERE ps2.proxy_address = ps.proxy_address 
        AND ps2.timestamp < ps.timestamp 
        AND ps2.usdc_balance > 0 
        ORDER BY ps2.timestamp DESC 
        LIMIT 1
    ) as new_usdc_balance,
    ps.positions_value
FROM portfolio_snapshots ps
WHERE ps.usdc_balance = 0 
AND ps.timestamp >= DATE_SUB(NOW(), INTERVAL 1 DAY);

-- 更新记录
UPDATE portfolio_snapshots ps
INNER JOIN temp_fix tf ON ps.id = tf.id
SET 
    ps.usdc_balance = tf.new_usdc_balance,
    ps.portfolio_total = tf.new_usdc_balance + tf.positions_value
WHERE tf.new_usdc_balance IS NOT NULL;

-- 查看更新了多少条
SELECT ROW_COUNT() as updated_rows;

-- 清理
DROP TEMPORARY TABLE temp_fix;
