mod config;
mod db;
mod error;
mod portfolio;

use axum::{Router, routing::get, Json, extract::Query};
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{CorsLayer, Any};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use sqlx::mysql::MySqlPool;

use crate::config::WalletConfig;
use crate::portfolio::{PortfolioData, PortfolioService};

type SharedState = Arc<AppState>;

struct AppState {
    wallets: Vec<WalletConfig>,
    cache: RwLock<std::collections::HashMap<String, PortfolioData>>,
    db_pool: MySqlPool,
}

#[derive(serde::Deserialize)]
struct HistoryQuery {
    hours: Option<i64>,
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
        .layer(cors)
        .with_state(state);

    let addr = "0.0.0.0:8405";
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
    let service = PortfolioService::new();
    let mut results = Vec::new();
    let mut wallet_totals = std::collections::HashMap::new();

    for wallet in &state.wallets {
        match service.fetch_portfolio(&wallet.proxy_address).await {
            Ok(data) => {
                // 保存到数据库
                if let Err(e) = db::save_snapshot(
                    &state.db_pool,
                    &data.proxy_address,
                    data.portfolio_total,
                    data.usdc_balance,
                    data.positions_value,
                ).await {
                    tracing::error!("保存快照失败: {}", e);
                }
                
                wallet_totals.insert(wallet.proxy_address.clone(), data.usdc_balance);
                results.push(data);
            }
            Err(e) => {
                tracing::error!("获取钱包 {} 数据失败: {}", wallet.name, e);
            }
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
                usdc_balance: s.usdc_balance.to_string().parse().unwrap_or(0.0),
                positions_value: s.positions_value.to_string().parse().unwrap_or(0.0),
                portfolio_total: s.portfolio_total.to_string().parse().unwrap_or(0.0),
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
            let mut grouped: std::collections::BTreeMap<i64, std::collections::HashMap<String, f64>> = std::collections::BTreeMap::new();
            
            for snapshot in snapshots {
                let ts = snapshot.timestamp.timestamp_millis();
                // 按分钟取整
                let ts_rounded = (ts / 60000) * 60000;
                
                let entry = grouped.entry(ts_rounded).or_default();
                entry.insert(
                    snapshot.proxy_address,
                    snapshot.usdc_balance.to_string().parse().unwrap_or(0.0)
                );
            }
            
            let history: Vec<_> = grouped.into_iter().map(|(timestamp, wallets)| {
                let total: f64 = wallets.values().sum();
                serde_json::json!({
                    "timestamp": timestamp,
                    "total": total,
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
