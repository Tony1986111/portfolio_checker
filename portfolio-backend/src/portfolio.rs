use alloy::primitives::Address;
use alloy::providers::ProviderBuilder;
use alloy::sol;
use serde::{Deserialize, Serialize};
use crate::error::AppError;

const POLYGON_RPC_PUBLIC: &str = "https://polygon-rpc.com";
const USDC_ADDRESS: &str = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const DATA_API_URL: &str = "https://data-api.polymarket.com";

// 获取 RPC 端点列表（公共 + 备用）
fn get_rpc_endpoints() -> Vec<String> {
    let mut endpoints = vec![POLYGON_RPC_PUBLIC.to_string()];
    
    // Alchemy 备用
    if let Ok(alchemy_key) = std::env::var("alchemy_API_Key") {
        if !alchemy_key.is_empty() {
            endpoints.push(format!("https://polygon-mainnet.g.alchemy.com/v2/{}", alchemy_key));
        }
    }
    
    // Infura 备用
    if let Ok(infura_key) = std::env::var("Infura_API_KEY") {
        if !infura_key.is_empty() {
            endpoints.push(format!("https://polygon-mainnet.infura.io/v3/{}", infura_key));
        }
    }
    
    endpoints
}

sol! {
    #[sol(rpc)]
    interface IERC20 {
        function balanceOf(address owner) external view returns (uint256);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortfolioData {
    pub proxy_address: String,
    pub usdc_balance: f64,
    pub positions_value: f64,
    pub portfolio_total: f64,
    pub last_updated: i64,
}

pub struct PortfolioService {
    http_client: reqwest::Client,
}

impl PortfolioService {
    pub fn new() -> Self {
        Self {
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap(),
        }
    }

    pub async fn fetch_portfolio(&self, proxy_address: &str) -> Result<PortfolioData, AppError> {
        let (usdc_result, positions_result) = tokio::join!(
            self.get_usdc_balance(proxy_address),
            self.get_positions_value(proxy_address)
        );

        // USDC 余额获取失败时返回错误，让调用方处理兜底逻辑
        let usdc_balance = usdc_result?;
        let positions_value = positions_result.unwrap_or(0.0);

        Ok(PortfolioData {
            proxy_address: proxy_address.to_string(),
            usdc_balance,
            positions_value,
            portfolio_total: usdc_balance + positions_value,
            last_updated: chrono::Utc::now().timestamp_millis(),
        })
    }


    async fn get_usdc_balance(&self, proxy_address: &str) -> Result<f64, AppError> {
        let usdc_addr: Address = USDC_ADDRESS.parse()
            .map_err(|e| AppError::ParseError(format!("{}", e)))?;
        
        let wallet_addr: Address = proxy_address.parse()
            .map_err(|e| AppError::ParseError(format!("{}", e)))?;

        let endpoints = get_rpc_endpoints();
        let mut last_error = None;
        
        // 依次尝试每个 RPC 端点
        for (idx, rpc_url) in endpoints.iter().enumerate() {
            let provider = ProviderBuilder::new()
                .connect_http(rpc_url.parse().unwrap());

            let contract = IERC20::new(usdc_addr, &provider);
            
            match contract.balanceOf(wallet_addr).call().await {
                Ok(result) => {
                    let balance_f64 = result.to_string().parse::<f64>().unwrap_or(0.0) / 1_000_000.0;
                    if idx > 0 {
                        tracing::info!("使用备用 RPC {} 成功获取 USDC 余额", idx);
                    }
                    return Ok(balance_f64);
                }
                Err(e) => {
                    tracing::warn!("RPC {} 获取 USDC 余额失败: {}", idx, e);
                    last_error = Some(e);
                }
            }
        }

        Err(AppError::RpcError(format!("所有 RPC 端点都失败: {:?}", last_error)))
    }

    async fn get_positions_value(&self, proxy_address: &str) -> Result<f64, AppError> {
        let url = format!("{}/value?user={}", DATA_API_URL, proxy_address);
        
        let resp = self.http_client
            .get(&url)
            .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")
            .send()
            .await
            .map_err(|e| AppError::ApiError(format!("{}", e)))?;

        if !resp.status().is_success() {
            return Ok(0.0);
        }

        let data: serde_json::Value = resp.json()
            .await
            .map_err(|e| AppError::ParseError(format!("{}", e)))?;

        // 响应可能是列表或字典
        if let Some(arr) = data.as_array() {
            for item in arr {
                if let Some(value) = item.get("value") {
                    return Ok(value.as_f64().unwrap_or(0.0));
                }
            }
        } else if let Some(value) = data.get("value") {
            return Ok(value.as_f64().unwrap_or(0.0));
        }

        Ok(0.0)
    }
}
