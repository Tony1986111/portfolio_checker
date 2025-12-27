use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletConfig {
    pub wallet_id: String,
    pub name: String,
    pub proxy_address: String,
}

pub fn load_wallets_from_env() -> Vec<WalletConfig> {
    let mut wallets = Vec::new();
    
    for i in 1..=10 {
        let key = format!("WALLET_{}_PROXY_ADDRESS", i);
        if let Ok(proxy_address) = std::env::var(&key) {
            if !proxy_address.is_empty() {
                wallets.push(WalletConfig {
                    wallet_id: i.to_string(),
                    name: format!("钱包 {}", i),
                    proxy_address,
                });
            }
        }
    }
    
    wallets
}
