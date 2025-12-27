# Portfolio 数据架构文档

本文档详细说明首页 Portfolio 数据的获取、存储和显示机制，供创建独立项目参考。

---

## 1. 数据概览

首页显示的每个钱包的 Portfolio 数据包括：

| 字段 | 说明 | 数据来源 |
|------|------|----------|
| `portfolio_total` | 总资产 = USDC余额 + 持仓总价值 | 计算得出 |
| `usdc_balance` | USDC 余额 | Polygon RPC |
| `positions_value` | 持仓总价值 | Polymarket Data API |
| `proxy_address` | 钱包代理地址 | 本地配置文件 |

---

## 2. 钱包列表来源

### 2.1 配置文件位置

钱包配置存储在 `config/wallets_config.json`，格式如下：

```json
{
  "1": {
    "name": "钱包 1",
    "proxy_address": "0x1234...abcd",
    "enabled": true,
    "strategy": { ... },
    "following": [ ... ]
  },
  "2": {
    "name": "钱包 2",
    "proxy_address": "0x5678...efgh",
    "enabled": true,
    ...
  }
}
```

### 2.2 钱包自动发现机制

系统启动时会扫描 `.env` 文件中的proxy地址环境变量：

```bash
# .env 文件
WALLET_1_PROXY_ADDRESS=0x...
WALLET_2_PROXY_ADDRESS=0x...
WALLET_3_PROXY_ADDRESS=0x...
# 支持 WALLET_1 到 WALLET_10
```


### 2.3 获取钱包列表的代码

```python
# backend/core/config_manager.py
from backend.core.config_manager import get_config_manager

config_manager = get_config_manager()
wallets = config_manager.get_all_wallets()  # Dict[str, WalletConfig]

for wallet_id, wallet in wallets.items():
    print(f"钱包ID: {wallet_id}")
    print(f"名称: {wallet.name}")
    print(f"代理地址: {wallet.proxy_address}")
```

---

## 3. Portfolio 数据获取

### 3.1 USDC 余额获取

**数据源**: Polygon RPC (https://polygon-rpc.com)

**合约地址**: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` (USDC on Polygon)

**实现代码** (`backend/utils/cashout_service.py`):

```python
from web3 import Web3

def get_usdc_balance(proxy_address: str) -> float:
    """获取钱包的 USDC 余额"""
    USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
    USDC_ABI = [
        {
            "constant": True,
            "inputs": [{"name": "_owner", "type": "address"}],
            "name": "balanceOf",
            "outputs": [{"name": "balance", "type": "uint256"}],
            "type": "function"
        }
    ]
    
    w3 = Web3(Web3.HTTPProvider("https://polygon-rpc.com", request_kwargs={'timeout': 5}))
    usdc_contract = w3.eth.contract(address=USDC_ADDRESS, abi=USDC_ABI)
    
    balance_wei = usdc_contract.functions.balanceOf(
        Web3.to_checksum_address(proxy_address)
    ).call()
    
    # USDC 有 6 位小数
    return balance_wei / 1e6
```

### 3.2 持仓总价值获取

**数据源**: Polymarket Data API

**API 端点**: `https://data-api.polymarket.com/value`

**请求参数**: `?user={proxy_address}`

**实现代码** (`backend/utils/cashout_service.py`):

```python
import requests

DATA_API_URL = "https://data-api.polymarket.com"
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
}

def get_positions_value(proxy_address: str) -> float:
    """获取钱包的持仓总价值"""
    resp = requests.get(
        f"{DATA_API_URL}/value",
        params={"user": proxy_address},
        headers=HEADERS,
        timeout=8,
    )
    
    if resp.status_code != 200:
        return None
    
    data = resp.json()
    
    # 响应可能是列表或字典
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and "value" in item:
                return float(item.get("value"))
    elif isinstance(data, dict):
        return float(data.get("value"))
    
    return None
```

### 3.3 API 响应示例

**USDC 余额**: 直接返回 uint256，除以 1e6 得到实际金额

**持仓价值 API 响应**:
```json
{
  "value": 1234.56
}
```
或
```json
[
  {"value": 1234.56}
]
```

---

## 4. 数据存储

### 4.1 MySQL 数据库存储

Portfolio 快照保存在 `portfolio_snapshots` 表中：

```sql
CREATE TABLE portfolio_snapshots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    timestamp DATETIME NOT NULL,           -- 快照时间
    proxy_address VARCHAR(255) NOT NULL,   -- 钱包代理地址
    portfolio_total DECIMAL(20, 6) NOT NULL DEFAULT 0,  -- 总资产
    usdc_balance DECIMAL(20, 6) NOT NULL DEFAULT 0,     -- USDC余额
    positions_value DECIMAL(20, 6) NOT NULL DEFAULT 0,  -- 持仓总价值
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_timestamp (timestamp),
    INDEX idx_proxy_address (proxy_address),
    INDEX idx_timestamp_address (timestamp, proxy_address)
);
```

**数据库配置** (默认):
- Host: localhost
- User: root
- Password: (空)
- Database: polymarket_bot

### 4.2 内存缓存

最新一次刷新的数据保存在内存缓存中，格式：

```python
# backend/utils/portfolio_service.py
_cache = {
    "0x1234...abcd": {
        "portfolio_total": 1500.50,
        "usdc_balance": 500.00,
        "positions_value": 1000.50,
        "last_updated": datetime(2024, 1, 1, 12, 0, 0)
    },
    "0x5678...efgh": {
        ...
    }
}
```

### 4.3 前端 LocalStorage 缓存

前端也会在 LocalStorage 中缓存数据，用于快速显示：

```javascript
// Key: dashboard_cached_data
{
  "totalPortfolio": 3000.00,
  "totalUsdcBalance": 1000.00,
  "totalPositionsValue": 2000.00,
  "walletCount": 2,
  "runningCount": 1,
  "totalOrders": 10,
  "timestamp": 1704110400000
}
```

---

## 5. 刷新机制

### 5.1 自动刷新

- **刷新间隔**: 10 分钟
- **实现位置**: `frontend-react/src/context/WalletsContext.jsx`

```javascript
const AUTO_REFRESH_INTERVAL = 10 * 60 * 1000  // 10分钟

useEffect(() => {
  const timer = setInterval(() => {
    fetchWallets(true)  // true = 获取余额数据
  }, AUTO_REFRESH_INTERVAL)
  
  return () => clearInterval(timer)
}, [fetchWallets])
```

### 5.2 手动刷新

用户点击"刷新"按钮时触发：

```javascript
<button onClick={() => fetchWallets(true)}>↻ 刷新</button>
```

### 5.3 刷新流程

```
1. 前端调用 GET /api/wallets?fetch_balances=true
2. 后端并发获取所有钱包的 USDC 余额和持仓价值
3. 计算 portfolio_total = usdc_balance + positions_value
4. 保存快照到 MySQL 数据库
5. 更新内存缓存
6. 返回数据给前端
7. 前端更新显示并保存到 LocalStorage
```

---

## 6. API 端点

### 6.1 获取钱包列表（带余额）

```
GET /api/wallets?fetch_balances=true
```

**响应**:
```json
[
  {
    "wallet_id": "1",
    "name": "钱包 1",
    "proxy_address": "0x1234...abcd",
    "enabled": true,
    "usdc_balance": 500.00,
    "positions_value": 1000.50,
    "portfolio_total": 1500.50,
    "status": "running",
    "orders_count": 5,
    "following_count": 3
  }
]
```

### 6.2 获取缓存的 Portfolio 数据

```
GET /api/portfolio/cached
```

**响应**:
```json
{
  "wallets": [
    {
      "wallet_id": "1",
      "proxy_address": "0x1234...abcd",
      "portfolio_total": 1500.50,
      "usdc_balance": 500.00,
      "positions_value": 1000.50,
      "last_updated": "2024-01-01T12:00:00"
    }
  ],
  "total_portfolio": 3000.00,
  "total_usdc_balance": 1000.00,
  "total_positions_value": 2000.00,
  "last_refresh_time": "2024-01-01T12:00:00"
}
```

### 6.3 手动刷新 Portfolio

```
POST /api/portfolio/refresh
```

**响应**:
```json
{
  "success": true,
  "saved_count": 2,
  "timestamp": "2024-01-01T12:00:00"
}
```

---

## 7. 资产总览曲线图

### 7.1 数据来源

曲线图数据来自前端的 `balanceHistory` 状态，每次刷新时追加一条记录：

```javascript
// frontend-react/src/context/WalletsContext.jsx
const [balanceHistory, setBalanceHistory] = useState([])

// 刷新时追加数据
setBalanceHistory((prev) => {
  const newEntry = {
    time: "12:00",
    timestamp: Date.now(),
    total: totalBalance,
    wallets: {
      "1": 1500.50,
      "2": 1500.00
    }
  }
  return [...prev.slice(-499), newEntry]  // 保留最近500条
})
```

### 7.2 历史数据查询

如需从数据库获取历史数据用于曲线图：

```sql
-- 获取某钱包最近100条快照
SELECT timestamp, portfolio_total, usdc_balance, positions_value
FROM portfolio_snapshots
WHERE proxy_address = '0x1234...abcd'
ORDER BY timestamp DESC
LIMIT 100;

-- 获取所有钱包某时间段的汇总
SELECT 
    DATE_FORMAT(timestamp, '%Y-%m-%d %H:00:00') as hour,
    SUM(portfolio_total) as total_portfolio
FROM portfolio_snapshots
WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
GROUP BY hour
ORDER BY hour;
```

---

## 8. 依赖库

### Python 后端

```
web3>=6.0.0          # 与 Polygon RPC 交互
requests>=2.28.0     # HTTP 请求
mysql-connector-python>=8.0.0  # MySQL 连接
fastapi>=0.100.0     # API 框架
```

### JavaScript 前端

```
recharts             # 图表库
framer-motion        # 动画
react-router-dom     # 路由
```

---

## 9. 简化版实现建议

如果只需要显示 Portfolio 数据和曲线图，可以简化为：

1. **配置文件**: 只需要 `proxy_address` 列表
2. **后端**: 只需要两个函数 `get_usdc_balance()` 和 `get_positions_value()`
3. **数据库**: 只需要 `portfolio_snapshots` 表
4. **前端**: 只需要钱包卡片组件和曲线图组件
5. **定时任务**: 每10分钟调用一次刷新接口

最小化的配置文件示例：

```json
{
  "wallets": [
    {"name": "钱包1", "proxy_address": "0x1234..."},
    {"name": "钱包2", "proxy_address": "0x5678..."}
  ],
  "refresh_interval_minutes": 10
}
```
