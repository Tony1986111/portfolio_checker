-- 修复所有 USDC 为 0 的记录
-- 用该记录之前最近的非零 USDC 数据填充

-- 创建临时表存储需要更新的记录及其应该填充的值
DROP TEMPORARY TABLE IF EXISTS temp_fix;

CREATE TEMPORARY TABLE temp_fix AS
SELECT 
    ps.id,
    (
        SELECT ps2.usdc_balance 
        FROM portfolio_snapshots ps2 
        WHERE ps2.proxy_address = ps.proxy_address 
        AND ps2.timestamp < ps.timestamp 
        AND ps2.usdc_balance > 0 
        ORDER BY ps2.timestamp DESC 
        LIMIT 1
    ) as new_usdc_balance,
    ps.positions_value
FROM portfolio_snapshots ps
WHERE ps.usdc_balance = 0;

-- 查看临时表内容
SELECT COUNT(*) as total_to_fix, SUM(CASE WHEN new_usdc_balance IS NOT NULL THEN 1 ELSE 0 END) as can_fix FROM temp_fix;

-- 更新记录
UPDATE portfolio_snapshots ps
INNER JOIN temp_fix tf ON ps.id = tf.id
SET 
    ps.usdc_balance = tf.new_usdc_balance,
    ps.portfolio_total = tf.new_usdc_balance + tf.positions_value
WHERE tf.new_usdc_balance IS NOT NULL;

SELECT ROW_COUNT() as updated_rows;

DROP TEMPORARY TABLE temp_fix;
