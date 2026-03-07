mod config;
mod db;
mod error;
mod portfolio;

use axum::{Router, routing::{get, delete}, Json, extract::Query};
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{CorsLayer, Any};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use sqlx::sqlite::SqlitePool;

use crate::config::WalletConfig;
use crate::portfolio::{PortfolioData, PortfolioService};

type SharedState = Arc<AppState>;

struct AppState {
    wallets: Vec<WalletConfig>,
    cache: RwLock<std::collections::HashMap<String, PortfolioData>>,
    db_pool: SqlitePool,
}

#[derive(serde::Deserialize)]
struct HistoryQuery {
    hours: Option<i64>,
}

#[derive(serde::Deserialize)]
struct DeleteSnapshotRequest {
    proxy_address: String,
    timestamp: i64,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("info"))
        .with(tracing_subscriber::fmt::layer())
        .init();

    dotenvy::from_path("../.env").ok();
    
    let wallets = config::load_wallets_from_env();
    tracing::info!("加载了 {} 个钱包配置", wallets.len());

    // 连接数据库
    let db_pool = match db::create_pool().await {
        Ok(pool) => {
            tracing::info!("数据库连接成功");
            pool
        }
        Err(e) => {
            tracing::error!("数据库连接失败: {}", e);
            panic!("无法连接数据库");
        }
    };

    let state = Arc::new(AppState {
        wallets,
        cache: RwLock::new(std::collections::HashMap::new()),
        db_pool,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/wallets", get(get_wallets))
        .route("/api/portfolio/refresh", get(refresh_portfolio))
        .route("/api/portfolio/cached", get(get_cached))
        .route("/api/portfolio/history", get(get_history))
        .route("/api/portfolio/snapshot", delete(delete_snapshot))
        .layer(cors)
        .with_state(state);

    let addr = "127.0.0.1:8405";
    tracing::info!("后端服务启动在 http://{}", addr);
    
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health() -> &'static str {
    "OK"
}

async fn get_wallets(
    axum::extract::State(state): axum::extract::State<SharedState>,
) -> Json<Vec<WalletConfig>> {
    Json(state.wallets.clone())
}

async fn refresh_portfolio(
    axum::extract::State(state): axum::extract::State<SharedState>,
) -> Json<serde_json::Value> {
    let service = std::sync::Arc::new(PortfolioService::new());
    
    // 并行请求所有钱包
    let futures: Vec<_> = state.wallets.iter().map(|wallet| {
        let service = service.clone();
        let proxy_address = wallet.proxy_address.clone();
        let wallet_name = wallet.name.clone();
        let db_pool = state.db_pool.clone();
        
        async move {
            // 重试机制：最多尝试 2 次
            let mut last_error = None;
            for attempt in 1..=2 {
                match service.fetch_portfolio(&proxy_address).await {
                    Ok(data) => return Some(data),
                    Err(e) => {
                        tracing::warn!("获取钱包 {} 数据失败 (尝试 {}/2): {}", wallet_name, attempt, e);
                        last_error = Some(e);
                        if attempt < 2 {
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        }
                    }
                }
            }
            
            // 重试都失败，尝试从数据库获取最近一条 USDC 不为 0 的记录作为兜底
            tracing::error!("获取钱包 {} 数据最终失败: {:?}，尝试使用历史数据", wallet_name, last_error);
            match db::get_latest_nonzero_usdc_snapshot(&db_pool, &proxy_address).await {
                Ok(Some(snapshot)) => {
                    tracing::info!("使用钱包 {} 的历史非零USDC数据作为兜底", wallet_name);
                    Some(PortfolioData {
                        proxy_address: snapshot.proxy_address,
                        usdc_balance: snapshot.usdc_balance,
                        positions_value: snapshot.positions_value,
                        portfolio_total: snapshot.portfolio_total,
                        last_updated: snapshot.timestamp.timestamp_millis(),
                    })
                }
                _ => {
                    tracing::error!("钱包 {} 没有非零USDC历史数据可用", wallet_name);
                    None
                }
            }
        }
    }).collect();
    
    let results: Vec<PortfolioData> = futures::future::join_all(futures)
        .await
        .into_iter()
        .flatten()
        .collect();

    // 保存到数据库
    for data in &results {
        if let Err(e) = db::save_snapshot(
            &state.db_pool,
            &data.proxy_address,
            data.portfolio_total,
            data.usdc_balance,
            data.positions_value,
        ).await {
            tracing::error!("保存快照失败: {}", e);
        }
    }

    let total: f64 = results.iter().map(|d| d.portfolio_total).sum();
    let timestamp = chrono::Utc::now().timestamp_millis();

    // 更新缓存
    {
        let mut cache = state.cache.write().await;
        for data in &results {
            cache.insert(data.proxy_address.clone(), data.clone());
        }
    }

    Json(serde_json::json!({
        "success": true,
        "data": results,
        "total": total,
        "timestamp": timestamp
    }))
}

async fn get_cached(
    axum::extract::State(state): axum::extract::State<SharedState>,
) -> Json<serde_json::Value> {
    // 先尝试从内存缓存读取
    let cache = state.cache.read().await;
    if !cache.is_empty() {
        let wallets: Vec<_> = cache.values().cloned().collect();
        let total: f64 = wallets.iter().map(|d| d.portfolio_total).sum();
        let total_usdc: f64 = wallets.iter().map(|d| d.usdc_balance).sum();
        let total_positions: f64 = wallets.iter().map(|d| d.positions_value).sum();
        return Json(serde_json::json!({
            "wallets": wallets,
            "total_portfolio": total,
            "total_usdc_balance": total_usdc,
            "total_positions_value": total_positions
        }));
    }
    drop(cache);

    // 内存缓存为空，从数据库读取最新快照
    match db::get_latest_snapshots(&state.db_pool).await {
        Ok(snapshots) => {
            let wallets: Vec<PortfolioData> = snapshots.iter().map(|s| PortfolioData {
                proxy_address: s.proxy_address.clone(),
                usdc_balance: s.usdc_balance,
                positions_value: s.positions_value,
                portfolio_total: s.portfolio_total,
                last_updated: s.timestamp.timestamp_millis(),
            }).collect();
            
            let total: f64 = wallets.iter().map(|d| d.portfolio_total).sum();
            let total_usdc: f64 = wallets.iter().map(|d| d.usdc_balance).sum();
            let total_positions: f64 = wallets.iter().map(|d| d.positions_value).sum();
            
            Json(serde_json::json!({
                "wallets": wallets,
                "total_portfolio": total,
                "total_usdc_balance": total_usdc,
                "total_positions_value": total_positions
            }))
        }
        Err(e) => {
            tracing::error!("从数据库读取缓存失败: {}", e);
            Json(serde_json::json!({
                "wallets": [],
                "total_portfolio": 0,
                "total_usdc_balance": 0,
                "total_positions_value": 0
            }))
        }
    }
}

async fn get_history(
    axum::extract::State(state): axum::extract::State<SharedState>,
    Query(query): Query<HistoryQuery>,
) -> Json<serde_json::Value> {
    let hours = query.hours.unwrap_or(24); // 默认24小时
    
    match db::get_history(&state.db_pool, hours).await {
        Ok(snapshots) => {
            // 按时间戳分组，构建前端需要的格式
            // 存储每个时间点每个钱包的完整数据
            #[derive(Default)]
            struct WalletSnapshot {
                usdc_balance: f64,
                positions_value: f64,
                portfolio_total: f64,
            }
            
            let mut grouped: std::collections::BTreeMap<i64, std::collections::HashMap<String, WalletSnapshot>> = std::collections::BTreeMap::new();
            
            for snapshot in snapshots {
                let ts = snapshot.timestamp.timestamp_millis();
                // 按分钟取整
                let ts_rounded = (ts / 60000) * 60000;
                
                let entry = grouped.entry(ts_rounded).or_default();
                entry.insert(
                    snapshot.proxy_address.clone(),
                    WalletSnapshot {
                        usdc_balance: snapshot.usdc_balance,
                        positions_value: snapshot.positions_value,
                        portfolio_total: snapshot.portfolio_total,
                    }
                );
            }
            
            let history: Vec<_> = grouped.into_iter().map(|(timestamp, wallet_snapshots)| {
                // 计算总计
                let total_usdc: f64 = wallet_snapshots.values().map(|w| w.usdc_balance).sum();
                let total_positions: f64 = wallet_snapshots.values().map(|w| w.positions_value).sum();
                let total_portfolio: f64 = wallet_snapshots.values().map(|w| w.portfolio_total).sum();
                
                // 构建每个钱包的 USDC 余额 map（保持向后兼容）
                let wallets: std::collections::HashMap<String, f64> = wallet_snapshots.iter()
                    .map(|(addr, w)| (addr.clone(), w.usdc_balance))
                    .collect();
                
                serde_json::json!({
                    "timestamp": timestamp,
                    "total": total_usdc,
                    "total_usdc": total_usdc,
                    "total_positions": total_positions,
                    "total_portfolio": total_portfolio,
                    "wallets": wallets
                })
            }).collect();
            
            Json(serde_json::json!(history))
        }
        Err(e) => {
            tracing::error!("获取历史数据失败: {}", e);
            Json(serde_json::json!([]))
        }
    }
}

async fn delete_snapshot(
    axum::extract::State(state): axum::extract::State<SharedState>,
    Json(payload): Json<DeleteSnapshotRequest>,
) -> Json<serde_json::Value> {
    tracing::info!("删除快照请求: 钱包={}, 时间戳={}", payload.proxy_address, payload.timestamp);
    
    match db::delete_snapshot(&state.db_pool, &payload.proxy_address, payload.timestamp).await {
        Ok(rows_affected) => {
            if rows_affected > 0 {
                tracing::info!("成功删除 {} 条记录", rows_affected);
                Json(serde_json::json!({
                    "success": true,
                    "message": format!("成功删除 {} 条记录", rows_affected),
                    "rows_affected": rows_affected
                }))
            } else {
                tracing::warn!("未找到匹配的记录");
                Json(serde_json::json!({
                    "success": false,
                    "message": "未找到匹配的记录"
                }))
            }
        }
        Err(e) => {
            tracing::error!("删除快照失败: {}", e);
            Json(serde_json::json!({
                "success": false,
                "message": format!("删除失败: {}", e)
            }))
        }
    }
}
