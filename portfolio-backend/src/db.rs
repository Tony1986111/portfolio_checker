use chrono::{DateTime, Utc};
use sqlx::sqlite::SqlitePool;
use crate::error::AppError;

#[derive(Debug, sqlx::FromRow)]
#[allow(dead_code)]
pub struct PortfolioSnapshot {
    pub id: i64,
    pub timestamp: DateTime<Utc>,
    pub proxy_address: String,
    pub portfolio_total: f64,
    pub usdc_balance: f64,
    pub positions_value: f64,
}

pub async fn create_pool() -> Result<SqlitePool, AppError> {
    use sqlx::sqlite::SqlitePoolOptions;
    use std::time::Duration;
    
    let database_url = "sqlite:portfolio_checker.db";
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Duration::from_secs(300))
        .max_lifetime(Duration::from_secs(1800))
        .connect(database_url)
        .await
        .map_err(|e| AppError::DbError(format!("连接数据库失败: {}", e)))?;
    
    // 创建表（如果不存在）
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS portfolio_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME NOT NULL,
            proxy_address TEXT NOT NULL,
            portfolio_total REAL NOT NULL,
            usdc_balance REAL NOT NULL,
            positions_value REAL NOT NULL
        )"
    )
    .execute(&pool)
    .await
    .map_err(|e| AppError::DbError(format!("创建表失败: {}", e)))?;
    
    // 创建索引
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_timestamp ON portfolio_snapshots(timestamp)")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_proxy_address ON portfolio_snapshots(proxy_address)")
        .execute(&pool)
        .await
        .ok();
    
    Ok(pool)
}

pub async fn save_snapshot(
    pool: &SqlitePool,
    proxy_address: &str,
    portfolio_total: f64,
    usdc_balance: f64,
    positions_value: f64,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO portfolio_snapshots (timestamp, proxy_address, portfolio_total, usdc_balance, positions_value) VALUES (datetime('now'), ?, ?, ?, ?)"
    )
    .bind(proxy_address)
    .bind(portfolio_total)
    .bind(usdc_balance)
    .bind(positions_value)
    .execute(pool)
    .await
    .map_err(|e| AppError::DbError(format!("保存快照失败: {}", e)))?;
    
    Ok(())
}

pub async fn get_history(
    pool: &SqlitePool,
    hours: i64,
) -> Result<Vec<PortfolioSnapshot>, AppError> {
    let snapshots = sqlx::query_as::<_, PortfolioSnapshot>(
        "SELECT id, timestamp, proxy_address, portfolio_total, usdc_balance, positions_value 
         FROM portfolio_snapshots 
         WHERE timestamp >= datetime('now', '-' || ? || ' hours')
         ORDER BY timestamp ASC"
    )
    .bind(hours)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::DbError(format!("查询历史失败: {}", e)))?;
    
    Ok(snapshots)
}

pub async fn get_latest_snapshots(
    pool: &SqlitePool,
) -> Result<Vec<PortfolioSnapshot>, AppError> {
    // 获取每个钱包的最新一条记录
    let snapshots = sqlx::query_as::<_, PortfolioSnapshot>(
        "SELECT ps.id, ps.timestamp, ps.proxy_address, ps.portfolio_total, ps.usdc_balance, ps.positions_value
         FROM portfolio_snapshots ps
         INNER JOIN (
             SELECT proxy_address, MAX(timestamp) as max_ts
             FROM portfolio_snapshots
             GROUP BY proxy_address
         ) latest ON ps.proxy_address = latest.proxy_address AND ps.timestamp = latest.max_ts"
    )
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::DbError(format!("查询最新快照失败: {}", e)))?;
    
    Ok(snapshots)
}

#[allow(dead_code)]
pub async fn get_latest_snapshot_for_wallet(
    pool: &SqlitePool,
    proxy_address: &str,
) -> Result<Option<PortfolioSnapshot>, AppError> {
    let snapshot = sqlx::query_as::<_, PortfolioSnapshot>(
        "SELECT id, timestamp, proxy_address, portfolio_total, usdc_balance, positions_value
         FROM portfolio_snapshots
         WHERE proxy_address = ?
         ORDER BY timestamp DESC
         LIMIT 1"
    )
    .bind(proxy_address)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::DbError(format!("查询钱包最新快照失败: {}", e)))?;
    
    Ok(snapshot)
}

pub async fn get_latest_nonzero_usdc_snapshot(
    pool: &SqlitePool,
    proxy_address: &str,
) -> Result<Option<PortfolioSnapshot>, AppError> {
    let snapshot = sqlx::query_as::<_, PortfolioSnapshot>(
        "SELECT id, timestamp, proxy_address, portfolio_total, usdc_balance, positions_value
         FROM portfolio_snapshots
         WHERE proxy_address = ? AND usdc_balance > 0
         ORDER BY timestamp DESC
         LIMIT 1"
    )
    .bind(proxy_address)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::DbError(format!("查询钱包非零USDC快照失败: {}", e)))?;
    
    Ok(snapshot)
}

pub async fn delete_snapshot(
    pool: &SqlitePool,
    proxy_address: &str,
    timestamp: i64,
) -> Result<u64, AppError> {
    // 将毫秒时间戳转换为 DateTime
    let dt = chrono::DateTime::from_timestamp_millis(timestamp)
        .ok_or_else(|| AppError::ParseError("无效的时间戳".to_string()))?;
    
    // 删除指定钱包在指定时间点的记录（允许1分钟的误差范围）
    let result = sqlx::query(
        "DELETE FROM portfolio_snapshots 
         WHERE proxy_address = ? 
         AND timestamp BETWEEN datetime(?, '-1 minute') AND datetime(?, '+1 minute')"
    )
    .bind(proxy_address)
    .bind(dt.to_rfc3339())
    .bind(dt.to_rfc3339())
    .execute(pool)
    .await
    .map_err(|e| AppError::DbError(format!("删除快照失败: {}", e)))?;
    
    Ok(result.rows_affected())
}
