use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use sqlx::mysql::MySqlPool;
use crate::error::AppError;

#[derive(Debug, sqlx::FromRow)]
#[allow(dead_code)]
pub struct PortfolioSnapshot {
    pub id: i32,
    pub timestamp: DateTime<Utc>,
    pub proxy_address: String,
    pub portfolio_total: Decimal,
    pub usdc_balance: Decimal,
    pub positions_value: Decimal,
}

pub async fn create_pool() -> Result<MySqlPool, AppError> {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "mysql://root@localhost/portfolio_checker".to_string());
    MySqlPool::connect(&database_url)
        .await
        .map_err(|e| AppError::DbError(format!("连接数据库失败: {}", e)))
}

pub async fn save_snapshot(
    pool: &MySqlPool,
    proxy_address: &str,
    portfolio_total: f64,
    usdc_balance: f64,
    positions_value: f64,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO portfolio_snapshots (timestamp, proxy_address, portfolio_total, usdc_balance, positions_value) VALUES (NOW(), ?, ?, ?, ?)"
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
    pool: &MySqlPool,
    hours: i64,
) -> Result<Vec<PortfolioSnapshot>, AppError> {
    let snapshots = sqlx::query_as::<_, PortfolioSnapshot>(
        "SELECT id, timestamp, proxy_address, portfolio_total, usdc_balance, positions_value 
         FROM portfolio_snapshots 
         WHERE timestamp >= DATE_SUB(NOW(), INTERVAL ? HOUR)
         ORDER BY timestamp ASC"
    )
    .bind(hours)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::DbError(format!("查询历史失败: {}", e)))?;
    
    Ok(snapshots)
}

pub async fn get_latest_snapshots(
    pool: &MySqlPool,
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
