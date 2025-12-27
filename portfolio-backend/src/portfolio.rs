use alloy::primitives::Address;
use alloy::providers::ProviderBuilder;
use alloy::sol;
use serde::{Deserialize, Serialize};
use crate::error::AppError;

const POLYGON_RPC: &str = "https://polygon-rpc.com";
const USDC_ADDRESS: &str = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const DATA_API_URL: &str = "https://data-api.polymarket.com";

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
        let (usdc_balance, positions_value) = tokio::join!(
            self.get_usdc_balance(proxy_address),
            self.get_positions_value(proxy_address)
        );

        let usdc_balance = usdc_balance.unwrap_or(0.0);
        let positions_value = positions_value.unwrap_or(0.0);

        Ok(PortfolioData {
            proxy_address: proxy_address.to_string(),
            usdc_balance,
            positions_value,
            portfolio_total: usdc_balance + positions_value,
            last_updated: chrono::Utc::now().timestamp_millis(),
        })
    }


    async fn get_usdc_balance(&self, proxy_address: &str) -> Result<f64, AppError> {
        let provider = ProviderBuilder::new()
            .connect_http(POLYGON_RPC.parse().unwrap());

        let usdc_addr: Address = USDC_ADDRESS.parse()
            .map_err(|e| AppError::ParseError(format!("{}", e)))?;
        
        let wallet_addr: Address = proxy_address.parse()
            .map_err(|e| AppError::ParseError(format!("{}", e)))?;

        let contract = IERC20::new(usdc_addr, &provider);
        
        let result = contract.balanceOf(wallet_addr)
            .call()
            .await
            .map_err(|e| AppError::RpcError(format!("{}", e)))?;

        // USDC有6位小数
        let balance_f64 = result.to_string().parse::<f64>().unwrap_or(0.0) / 1_000_000.0;
        Ok(balance_f64)
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
