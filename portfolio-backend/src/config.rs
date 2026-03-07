use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletConfig {
    pub wallet_id: String,
    pub name: String,
    pub proxy_address: String,
}

pub fn load_wallets_from_env() -> Vec<WalletConfig> {
    let mut wallets = Vec::new();
    
    // 自定义钱包名称映射
    let wallet_names = [
        ("1", "1-Sports"),
        ("2", "2-BTC-5m-10s"),
        ("3", "2-BTC-5m-5s"),
        ("4", "4-BTC-5m-3s"),
        ("5", "5-BTC-5m-0s"),
        ("6", "6-1分钱"),
        ("7", "7-BTC-0s"),
        ("8", "8-BTC-2x"),
        ("9", "Poly-9-BTC-15m-5s"),
        ("10", "Poly-10-BTC-15m-3s"),
        ("11", "Poly-11-BTC-15m-1s"),
    ];
    
    for i in 1..=15 {
        let key = format!("WALLET_{}_PROXY_ADDRESS", i);
        if let Ok(proxy_address) = std::env::var(&key) {
            if !proxy_address.is_empty() {
                let wallet_id = i.to_string();
                let name = wallet_names.iter()
                    .find(|(id, _)| *id == wallet_id.as_str())
                    .map(|(_, name)| name.to_string())
                    .unwrap_or_else(|| format!("钱包 {}", i));
                
                wallets.push(WalletConfig {
                    wallet_id,
                    name,
                    proxy_address,
                });
            }
        }
    }
    
    wallets
}
