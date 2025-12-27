import os
import time
import requests
import mysql.connector

from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Set, Tuple
from zoneinfo import ZoneInfo
from web3 import Web3
from web3.exceptions import TransactionNotFound
from eth_account import Account
from eth_utils import keccak
from dotenv import load_dotenv
from py_builder_relayer_client.client import RelayClient
from py_builder_relayer_client.models import SafeTransaction, OperationType
from py_builder_signing_sdk.config import BuilderConfig
from py_builder_signing_sdk.sdk_types import BuilderApiKeyCreds
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

# Load environment variables
load_dotenv()

# Configuration
RELAYER_URL = os.getenv("RELAYER_URL", "https://relayer-v2.polymarket.com")  # Default to Mainnet
CHAIN_ID = 137  # Polygon Mainnet

# Conditional Token Framework (CTF) Address & Collateral (USDC) on Polygon
CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
COLLATERAL_TOKEN = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"  # USDC
PARENT_COLLECTION_ID = "0x" + "00" * 32  # bytes32(0)

# Scan interval (seconds)
SCAN_INTERVAL = 3600  # 1 hour

# Maximum number of wallets to check
MAX_WALLETS = 10

# API URLs
DATA_API_URL = "https://data-api.polymarket.com"
GAMMA_API_URL = "https://gamma-api.polymarket.com"
HEADERS = {"User-Agent": "Mozilla/5.0"}

# Polygon RPC URL for transaction verification
POLYGON_RPC_URL = "https://polygon-rpc.com"

# Database configuration
DB_CONFIG = {
    'host': 'localhost',
    'user': 'root',
    'password': '',
    'database': 'polymarket_bot',
    'charset': 'utf8mb4',
    'collation': 'utf8mb4_unicode_ci',
    'autocommit': True
}

# Web3 instance for transaction verification
w3_polygon = Web3(Web3.HTTPProvider(POLYGON_RPC_URL))

# ABI for CTF.redeemPositions（直接调用 CTF 合约时使用）
CTF_ABI = [
    {
        "constant": False,
        "inputs": [
            {"name": "collateralToken", "type": "address"},
            {"name": "parentCollectionId", "type": "bytes32"},
            {"name": "conditionId", "type": "bytes32"},
            {"name": "indexSets", "type": "uint256[]"},
        ],
        "name": "redeemPositions",
        "outputs": [],
        "payable": False,
        "stateMutability": "nonpayable",
        "type": "function",
    }
]

# Polymarket 自己的 Redeemer 合约（Router），前端就是通过这个合约来 redeem
REDEEMER_ADDRESS = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"

# 这里只需要它的 redeemPositions 接口即可
REDEEMER_ABI = [
    {
        "inputs": [
            {"internalType": "bytes32", "name": "_conditionId", "type": "bytes32"},
            {"internalType": "uint256[]", "name": "_amounts", "type": "uint256[]"},
        ],
        "name": "redeemPositions",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    }
]



# ========== Database Functions ==========

def get_db_connection():
    """获取数据库连接"""
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        return conn
    except Exception as e:
        print(f"❌ 数据库连接失败: {e}")
        return None


def ensure_redeem_table_exists(wallet_id: str):
    """确保 redeem 记录表存在（记录失败和跳过的）"""
    conn = get_db_connection()
    if not conn:
        return False
    
    try:
        cursor = conn.cursor()
        table_name = f"wallet_{wallet_id}_redeems"
        
        create_table_sql = f"""
        CREATE TABLE IF NOT EXISTS `{table_name}` (
            `id` INT AUTO_INCREMENT PRIMARY KEY,
            `token_id` VARCHAR(255) NOT NULL,
            `condition_id` VARCHAR(255) NOT NULL,
            `outcome_index` INT NOT NULL,
            `winning_outcome_index` INT,
            `market_title` VARCHAR(500),
            `prediction_result` ENUM('success', 'failed') NOT NULL,
            `redeem_status` ENUM('pending', 'success', 'failed', 'skipped') NOT NULL DEFAULT 'pending',
            `redeem_tx_hash` VARCHAR(255),
            `checked_at` DATETIME NOT NULL,
            `redeemed_at` DATETIME,
            `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY `uk_token_condition` (`token_id`, `condition_id`, `outcome_index`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """
        
        cursor.execute(create_table_sql)
        conn.commit()
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"   ❌ 创建 redeems 表失败: {e}")
        if conn:
            conn.close()
        return False


def get_skipped_tokens(wallet_id: str) -> Set[str]:
    """获取已跳过（预测失败）的 token_id 集合（从 redeems 表）"""
    conn = get_db_connection()
    if not conn:
        return set()
    
    try:
        cursor = conn.cursor()
        table_name = f"wallet_{wallet_id}_redeems"
        
        # 查询所有已跳过的 token_id
        cursor.execute(f"""
            SELECT DISTINCT token_id 
            FROM `{table_name}` 
            WHERE redeem_status = 'skipped'
        """)
        
        result = set(row[0] for row in cursor.fetchall())
        cursor.close()
        conn.close()
        return result
        
    except mysql.connector.Error as e:
        if e.errno == 1146:  # Table doesn't exist
            return set()
        print(f"   ⚠️ 查询已跳过 token 失败: {e}")
        if conn:
            conn.close()
        return set()


def insert_redeem_record(wallet_id: str, record: dict) -> bool:
    """插入跳过的 redeem 记录到 redeems 表"""
    conn = get_db_connection()
    if not conn:
        return False
    
    try:
        cursor = conn.cursor()
        table_name = f"wallet_{wallet_id}_redeems"
        
        insert_sql = f"""
        INSERT INTO `{table_name}` 
        (token_id, condition_id, outcome_index, winning_outcome_index, 
         market_title, prediction_result, redeem_status, redeem_tx_hash, 
         checked_at, redeemed_at)
        VALUES (%(token_id)s, %(condition_id)s, %(outcome_index)s, %(winning_outcome_index)s,
                %(market_title)s, %(prediction_result)s, %(redeem_status)s, %(redeem_tx_hash)s,
                %(checked_at)s, %(redeemed_at)s)
        ON DUPLICATE KEY UPDATE
            winning_outcome_index = VALUES(winning_outcome_index),
            market_title = VALUES(market_title),
            prediction_result = VALUES(prediction_result),
            redeem_status = VALUES(redeem_status),
            redeem_tx_hash = VALUES(redeem_tx_hash),
            checked_at = VALUES(checked_at),
            redeemed_at = VALUES(redeemed_at)
        """
        
        cursor.execute(insert_sql, record)
        conn.commit()
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"   ❌ 插入 redeem 记录失败: {e}")
        if conn:
            conn.close()
        return False


# ========== Transaction Verification Functions ==========

def wait_for_transaction_receipt(tx_hash: str, timeout: int = 30, poll_interval: float = 2.0) -> Optional[dict]:
    """
    等待交易回执
    
    Args:
        tx_hash: 交易哈希
        timeout: 超时时间（秒）
        poll_interval: 轮询间隔（秒）
    
    Returns:
        交易回执字典，如果超时或失败返回 None
    """
    if not tx_hash or not tx_hash.startswith('0x'):
        return None
    
    start_time = time.time()
    
    while time.time() - start_time < timeout:
        try:
            receipt = w3_polygon.eth.get_transaction_receipt(tx_hash)
            if receipt:
                return dict(receipt)
        except TransactionNotFound:
            # 交易还未被打包，继续等待
            pass
        except Exception as e:
            print(f"   ⚠️ 查询交易回执时出错: {e}")
            return None
        
        time.sleep(poll_interval)
    
    return None


def verify_transaction_success(receipt: dict) -> bool:
    """
    验证交易是否成功
    
    Args:
        receipt: 交易回执
    
    Returns:
        True 如果交易成功，False 如果失败
    """
    if not receipt:
        return False
    
    # status = 1 表示成功，0 表示失败
    status = receipt.get('status')
    return status == 1


def process_redeem_result(wallet_id: str, token_info: dict, tx_hash: str, wallet_name: str):
    """
    处理单个 redeem 的结果（在后台线程中异步执行）
    
    Args:
        wallet_id: 钱包ID
        token_info: token 信息
        tx_hash: 交易哈希
        wallet_name: 钱包名称
    """
    token_id = token_info["token_id"]
    condition_id = token_info["condition_id"]
    
    print(f"   ⏳ [{wallet_name}] 等待交易确认: {token_id[:8]}... (tx: {tx_hash[:10]}...)")
    
    # 等待交易回执（最多30秒）
    receipt = wait_for_transaction_receipt(tx_hash, timeout=30)
    
    if receipt:
        # 验证交易是否成功
        is_success = verify_transaction_success(receipt)
        confirmed_at = datetime.now()
        
        if is_success:
            print(f"   ✅ [{wallet_name}] Redeem 成功: {token_id[:8]}... (tx confirmed)")
        else:
            print(f"   ❌ [{wallet_name}] Redeem 失败: {token_id[:8]}... (tx reverted)")
    else:
        print(f"   ⚠️ [{wallet_name}] 交易回执超时: {token_id[:8]}... (tx: {tx_hash[:10]}...)")
        # 超时，保持 pending 状态，下次可以重试


def is_market_settled(market: dict) -> bool:
    """
    判断市场是否已结算
    参考：已结算订单判断逻辑说明.md
    
    判断逻辑（按优先级）：
    1. 检查 umaResolutionStatus == "Resolved"（最可靠）
    2. 检查 closed == True 且 endDate < 当前时间
    3. 检查 outcomePrices 中有价格为 1.0 的 outcome（需确保 endDate 已过）
    """
    if not market:
        return False
    
    # 方法1：检查 umaResolutionStatus（最可靠）
    resolution_status = market.get("umaResolutionStatus")
    if resolution_status and resolution_status.lower() == "resolved":
        return True
    
    # 方法2：检查市场关闭状态和结束日期
    # 注意：必须同时满足 closed == True 且 endDate < 当前时间
    closed = market.get("closed")
    end_date = market.get("endDate")
    
    # 严格检查 closed 是否为 True（不能只是真值）
    if closed is True and end_date:
        try:
            end_date_str = str(end_date)
            if not end_date_str.endswith('Z') and not end_date_str.endswith('+00:00'):
                end_date_str += 'Z'
            end_time = datetime.fromisoformat(end_date_str.replace('Z', '+00:00'))
            now = datetime.now(timezone.utc)
            # 必须同时满足：closed == True 且 endDate < 当前时间
            if end_time < now:
                return True
        except Exception:
            pass
    
    # 方法3：检查 outcomePrices 是否有价格为 1.0 的 outcome
    # 注意：这个方法需要谨慎使用，因为未结算的市场也可能有价格为 1.0 的 outcome
    # 只有在方法1和方法2都无法判断时，才使用这个方法
    # 并且需要确保市场确实已经结束（通过 endDate 检查）
    outcome_prices = market.get("outcomePrices", [])
    # 处理可能是 JSON 字符串的情况
    if isinstance(outcome_prices, str):
        try:
            import json
            outcome_prices = json.loads(outcome_prices)
        except:
            outcome_prices = []
    
    # 只有在 endDate 已过的情况下，才使用 outcomePrices 判断
    if end_date:
        try:
            end_date_str = str(end_date)
            if not end_date_str.endswith('Z') and not end_date_str.endswith('+00:00'):
                end_date_str += 'Z'
            end_time = datetime.fromisoformat(end_date_str.replace('Z', '+00:00'))
            now = datetime.now(timezone.utc)
            
            # 只有当 endDate 已过时，才检查 outcomePrices
            if end_time < now:
                for price in outcome_prices:
                    try:
                        if float(price) == 1.0:
                            return True
                    except (ValueError, TypeError):
                        pass
        except Exception:
            pass
    
    return False


def get_winning_outcome_index(market: dict) -> Optional[int]:
    """
    获取获胜的 outcome 索引
    参考：已结算订单判断逻辑说明.md
    """
    if not market:
        return None
    
    # 方法1：从 outcomePrices 数组查找价格为 1.0 的
    outcome_prices = market.get("outcomePrices", [])
    # 处理可能是 JSON 字符串的情况
    if isinstance(outcome_prices, str):
        try:
            import json
            outcome_prices = json.loads(outcome_prices)
        except:
            outcome_prices = []
    
    for idx, price in enumerate(outcome_prices):
        try:
            if float(price) == 1.0:
                return idx
        except (ValueError, TypeError):
            pass
    
    # 方法2：从 outcomes 数组查找
    outcomes = market.get("outcomes", [])
    if outcomes and isinstance(outcomes, list):
        for idx, outcome in enumerate(outcomes):
            # 确保 outcome 是字典类型
            if isinstance(outcome, dict):
                if outcome.get("resolved") or outcome.get("winning"):
                    return idx
    
    # 方法3：从 resolvedOutcome 字段获取
    resolved_outcome = market.get("resolvedOutcome")
    if resolved_outcome is not None:
        try:
            return int(resolved_outcome)
        except (ValueError, TypeError):
            pass
    
    # 方法4：从 resolvedBy 字段获取
    resolved_by = market.get("resolvedBy")
    if resolved_by is not None:
        try:
            return int(resolved_by)
        except (ValueError, TypeError):
            pass
    
    # 方法5：从 resolution 对象获取
    resolution = market.get("resolution")
    if resolution and isinstance(resolution, dict):
        outcome = resolution.get("outcome")
        if outcome is not None:
            try:
                return int(outcome)
            except (ValueError, TypeError):
                pass
    
    return None


def fetch_market_details(condition_id: str, slug: Optional[str] = None) -> Optional[dict]:
    """
    获取市场详情
    参考：已结算订单数据来源说明.md
    """
    # 方法1：优先使用 slug（更可靠）
    if slug:
        try:
            url = f"{GAMMA_API_URL}/markets/slug/{slug}"
            resp = requests.get(url, headers=HEADERS, timeout=30)
            if resp.status_code == 200:
                market = resp.json()
                # 验证 conditionId 是否匹配
                if market.get("conditionId", "").lower() == condition_id.lower():
                    return market
        except Exception as e:
            print(f"   ⚠️ 通过 slug 获取市场失败: {e}")
    
    # 方法2：备用方案，使用 condition_id
    try:
        url = f"{GAMMA_API_URL}/markets"
        params = {"condition_id": condition_id}
        resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
        if resp.status_code == 200:
            markets = resp.json()
            # 查找精确匹配
            for m in markets:
                if m.get("conditionId", "").lower() == condition_id.lower():
                    return m
            # 如果没有精确匹配，使用第一个
            if markets:
                return markets[0]
    except Exception as e:
        print(f"   ⚠️ 通过 condition_id 获取市场失败: {e}")
    
    return None


def load_wallet_configs():
    """
    从环境变量中自动加载钱包配置
    格式: WALLET_X_PRIVATE_KEY 和 WALLET_X_PROXY_ADDRESS (X=1到10)
    """
    wallet_configs = []
    
    for i in range(1, MAX_WALLETS + 1):
        private_key_env = f"WALLET_{i}_PRIVATE_KEY"
        proxy_address_env = f"WALLET_{i}_PROXY_ADDRESS"
        
        private_key = os.getenv(private_key_env)
        proxy_address = os.getenv(proxy_address_env)
        
        # 如果找到私钥和代理地址，添加到配置中
        if private_key and proxy_address:
            wallet_configs.append({
                "name": f"Wallet {i}",
                "private_key": private_key,
                "proxy_address": proxy_address.lower()  # 统一转为小写
            })
            print(f"✅ Wallet {i}: {proxy_address}")
        elif private_key or proxy_address:
            # 如果只有其中一个，给出警告
            missing = []
            if not private_key:
                missing.append(private_key_env)
            if not proxy_address:
                missing.append(proxy_address_env)
            print(f"⚠️  警告: Wallet {i} 配置不完整，缺少: {', '.join(missing)}")
    
    return wallet_configs


def get_relayer_client(private_key: str):
    """创建 Relayer 客户端，使用指定的私钥"""
    api_key = os.getenv("BUILDER_POLY_API_KEY")
    api_secret = os.getenv("BUILDER_POLY_API_SECRET")
    api_passphrase = os.getenv("BUILDER_POLY_API_PASSPHRASE")

    if not (private_key and api_key and api_secret and api_passphrase):
        missing = []
        if not private_key:
            missing.append("PRIVATE_KEY")
        if not api_key:
            missing.append("BUILDER_POLY_API_KEY")
        if not api_secret:
            missing.append("BUILDER_POLY_API_SECRET")
        if not api_passphrase:
            missing.append("BUILDER_POLY_API_PASSPHRASE")
        print(f"❌ 缺少必要配置: {', '.join(missing)}")
        return None

    try:
        creds = BuilderApiKeyCreds(
            key=api_key, secret=api_secret, passphrase=api_passphrase
        )
        builder_config = BuilderConfig(local_builder_creds=creds)
        client = RelayClient(
            relayer_url=RELAYER_URL,
            chain_id=CHAIN_ID,
            private_key=private_key,
            builder_config=builder_config,
        )
        return client
    except Exception as e:
        print(f"❌ Relayer 客户端初始化失败: {e}")
        return None


def encode_redeem_data(condition_id: str, index_sets, parent_collection_id: Optional[str] = None):
    """根据 conditionId 和 indexSets 构造 redeemPositions 的 calldata"""

    w3 = Web3()
    contract = w3.eth.contract(address=CTF_ADDRESS, abi=CTF_ABI)

    condition_id_bytes = w3.to_bytes(hexstr=condition_id)
    parent_hex = parent_collection_id or PARENT_COLLECTION_ID
    parent_collection_id_bytes = w3.to_bytes(hexstr=parent_hex)

    # 优先使用 encodeABI（新版本 web3 的标准接口）
    try:
        data = contract.encodeABI(
            fn_name="redeemPositions",
            args=[
                COLLATERAL_TOKEN,
                parent_collection_id_bytes,
                condition_id_bytes,
                index_sets,
            ],
        )
    except Exception:
        # 兼容老版本 web3：使用内部的 _encode_transaction_data
        func = contract.functions.redeemPositions(
            COLLATERAL_TOKEN,
            parent_collection_id_bytes,
            condition_id_bytes,
            index_sets,
        )
        data = func._encode_transaction_data()  # type: ignore

    return data


def encode_neg_risk_redeem_data(condition_id: str, amounts):
    """构造 NegRiskAdapter.redeemPositions 的 calldata"""
    w3 = Web3()
    contract = w3.eth.contract(address=REDEEMER_ADDRESS, abi=REDEEMER_ABI)
    condition_id_bytes = w3.to_bytes(hexstr=condition_id)
    try:
        data = contract.encodeABI(
            fn_name="redeemPositions",
            args=[condition_id_bytes, amounts],
        )
    except Exception:
        func = contract.functions.redeemPositions(condition_id_bytes, amounts)
        data = func._encode_transaction_data()  # type: ignore
    return data



def get_user_address_from_private_key(private_key: str) -> Optional[str]:
    """从私钥获取 EOA 地址"""
    if private_key:
        try:
            return Account.from_key(private_key).address
        except Exception:
            return None
    return None


def derive_index_set_from_token(
    token_id: str,
    condition_id: str,
    parent_collection_id: str,
    max_index: int = 64,
) -> Optional[int]:
    """
    根据 token_id (positionId) 反推 indexSet。
    适用于负风险市场（parent_collection_id 非 0），避免错误使用固定 2^outcomeIndex。
    """
    try:
        token_int = int(token_id)
    except Exception:
        return None

    parent_hex = parent_collection_id or PARENT_COLLECTION_ID
    parent_bytes = Web3.to_bytes(hexstr=parent_hex)
    condition_bytes = Web3.to_bytes(hexstr=condition_id)
    collateral_bytes = Web3.to_bytes(hexstr=COLLATERAL_TOKEN)

    for idx in range(1, max_index + 1):
        idx_bytes = int(idx).to_bytes(32, "big")
        collection = keccak(parent_bytes + condition_bytes + idx_bytes)
        pos = int.from_bytes(keccak(collateral_bytes + collection), "big")
        if pos == token_int:
            return idx
    return None


def fetch_user_positions(user_address: str):
    """从 Data API 获取用户的所有持仓（支持分页）"""

    print(f"🔍 正在获取地址 {user_address} 的持仓...")
    
    all_positions = []
    offset = 0
    limit = 100  # 每次获取100条
    max_iterations = 100  # 防止无限循环
    
    for i in range(max_iterations):
        url = f"{DATA_API_URL}/positions"
        params = {
            "user": user_address,
            "limit": limit,
            "offset": offset
        }
        
        try:
            resp = requests.get(url, params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            
            if isinstance(data, list):
                batch_size = len(data)
                all_positions.extend(data)
                
                # 如果返回的数量少于 limit，说明已经获取完所有数据
                if batch_size < limit:
                    break
                
                offset += limit
            else:
                # 如果返回的不是列表，可能是错误或空数据
                break
                
        except Exception as e:
            print(f"   ⚠️ 获取持仓 API 失败 (offset={offset}): {e}")
            break
    
    if all_positions:
        print(f"   ✅ 获取到 {len(all_positions)} 个持仓（分 {i+1} 批次）")
    
    return all_positions


def fetch_redeemption_history(user_address: str):
    """
    从 Data API 获取已领取的订单历史。
    使用 /activity 接口，参数 type=REDEEM
    """
    print(f"🔍 正在获取地址 {user_address} 的历史领取记录...")
    url = f"https://data-api.polymarket.com/activity?user={user_address}&type=REDEEM"
    try:
        resp = requests.get(url, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, list):
                return data
    except Exception as e:
        print(f"   ⚠️ 获取历史领取记录失败: {e}")
    return []


def display_claimed_history(user_address: str):
    """
    获取并详细显示历史已 Claim 的单子
    """
    history = fetch_redeemption_history(user_address)
    if not history:
        print("📄 Data API 未返回任何历史 Claim 记录。")
        return

    print(f"\n📜 Data API 返回的历史已 Claim 记录共 {len(history)} 条:")
    print(f"{'时间':<20} | {'金额(USDC)':<12} | {'市场名称'}")
    print("-" * 100)

    for item in history:
        ts = item.get("timestamp")
        time_str = datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else "Unknown Time"
        
        amount = item.get("usdcSize") or item.get("size") or "0"
        amount_str = f"{float(amount):.2f}"
        
        title = item.get("title") or item.get("slug") or "Unknown Market"
        
        print(f"{time_str:<20} | {amount_str:<12} | {title}")

    print("-" * 100)
    print(f"   (共 {len(history)} 条记录)\n")


def claim_once(client: RelayClient, user_address: str, wallet_name: str, wallet_id: str):
    """
    单次扫描并尝试领取所有可 Claim 的市场。
    新逻辑：
    1. 先扫描所有 token_id，对比数据库找出新的
    2. 对于新 token_id，判断市场是否已结算，如果失败则记录并跳过
    3. 检查 redeemed 表，如果发现异常提示用户
    4. 对于剩余的，检查 redeemable 执行 redeem（并发 + 异步验证）
    """

    print(f"\n{'='*80}")
    print(f"🔄 正在处理 {wallet_name} ({user_address})")
    print(f"{'='*80}")

    # 确保数据库表存在
    ensure_redeem_table_exists(wallet_id)

    # 获取持仓
    positions = fetch_user_positions(user_address)
    if not positions:
        print("   当前账户无持仓。")
        return

    print(f"   当前持有 {len(positions)} 个 Position")

    # ========== 步骤1：收集所有 token_id 和 condition_id 信息 ==========
    position_map: Dict[str, dict] = {}  # token_id -> position info

    for p in positions:
        token_id = p.get("asset") or p.get("token_id")
        condition_id = p.get("conditionId")
        
        if not token_id or not condition_id:
            continue

        position_map[token_id] = {
            "condition_id": condition_id,
            "outcome_index": p.get("outcomeIndex"),
            "title": p.get("title") or p.get("slug") or "",
            "slug": p.get("slug") or p.get("eventSlug"),
            "redeemable": p.get("redeemable", False),
            "size": p.get("size", 0),
            "token_id": token_id,
        }
    
    print(f"   收集到 {len(position_map)} 个唯一 token")

    # ========== 步骤2：获取数据库中已处理的 token_id ==========
    skipped_tokens = get_skipped_tokens(wallet_id)
    
    print(f"   数据库中已有 {len(skipped_tokens)} 个跳过记录（预测失败）")

    # 找出新的 token_id（只排除 skipped，忽略 redeemed 表）
    new_tokens = set(position_map.keys()) - skipped_tokens
    print(f"   发现 {len(new_tokens)} 个新 token 需要检查")

    # ========== 步骤3：对新 token 判断市场是否已结算 ==========
    tokens_to_check_settlement = []
    
    if new_tokens:
        print(f"\n📊 开始检查新 token 的市场结算状态...")
        
        # 收集需要查询的市场信息
        market_queries: Dict[str, Tuple[str, Optional[str]]] = {}  # condition_id -> (condition_id, slug)
        for token_id in new_tokens:
            pos_info = position_map[token_id]
            condition_id = pos_info["condition_id"]
            if condition_id not in market_queries:
                market_queries[condition_id] = (condition_id, pos_info.get("slug"))
        
        # 批量获取市场详情（并发）
        print(f"   需要查询 {len(market_queries)} 个市场的详情...")
        markets_dict: Dict[str, Optional[dict]] = {}
        
        with ThreadPoolExecutor(max_workers=5) as executor:
            future_to_cond = {
                executor.submit(fetch_market_details, cond_id, slug): cond_id
                for cond_id, slug in market_queries.values()
            }
            
            for future in as_completed(future_to_cond):
                cond_id = future_to_cond[future]
                try:
                    market = future.result()
                    markets_dict[cond_id] = market
                except Exception as e:
                    print(f"   ⚠️ 获取市场 {cond_id[:8]}... 失败: {e}")
                    markets_dict[cond_id] = None
        
        # 检查每个新 token
        skipped_count = 0
        for token_id in new_tokens:
            pos_info = position_map[token_id]
            condition_id = pos_info["condition_id"]
            outcome_index = pos_info["outcome_index"]
            market_title = pos_info["title"]
            
            market = markets_dict.get(condition_id)
            
            if not market:
                # 无法获取市场信息，跳过
                tokens_to_check_settlement.append(token_id)
                continue
            
            # 判断市场是否已结算
            if is_market_settled(market):
                # 市场已结算，获取获胜 outcome
                winning_outcome = get_winning_outcome_index(market)
                
                if winning_outcome is None:
                    print(f"   ⚠️ {market_title} - 无法确定获胜 outcome")
                    tokens_to_check_settlement.append(token_id)
                    continue
                
                # 判断预测结果
                # 注意：需要确保类型一致（都转换为整数）
                try:
                    outcome_index_normalized = int(outcome_index)
                    winning_outcome_normalized = int(winning_outcome)
                    prediction_result = "success" if outcome_index_normalized == winning_outcome_normalized else "failed"
                    
                    # 调试信息
                    if outcome_index_normalized != winning_outcome_normalized:
                        print(f"   🔍 {market_title}")
                        print(f"      用户买入 outcome: {outcome_index_normalized} (原始: {outcome_index}, 类型: {type(outcome_index)})")
                        print(f"      获胜 outcome: {winning_outcome_normalized} (原始: {winning_outcome}, 类型: {type(winning_outcome)})")
                        print(f"      判断结果: {prediction_result}")
                except (ValueError, TypeError) as e:
                    print(f"   ⚠️ {market_title} - 无法比较 outcome_index ({outcome_index}) 和 winning_outcome ({winning_outcome}): {e}")
                    tokens_to_check_settlement.append(token_id)
                    continue
                
                if prediction_result == "failed":
                    # 预测失败，标记为已处理（跳过 redeem）
                    print(f"   ❌ {market_title} - 预测失败，跳过 redeem")
                    
                    record = {
                        "token_id": token_id,
                        "condition_id": condition_id,
                        "outcome_index": outcome_index,
                        "winning_outcome_index": winning_outcome,
                        "market_title": market_title,
                        "prediction_result": prediction_result,
                        "redeem_status": "skipped",
                        "redeem_tx_hash": None,
                        "checked_at": datetime.now(),
                        "redeemed_at": None
                    }
                    insert_redeem_record(wallet_id, record)
                    skipped_count += 1
                else:
                    # 预测成功，添加到待 redeem 列表
                    tokens_to_check_settlement.append(token_id)
            else:
                # 市场未结算，添加到待检查列表
                tokens_to_check_settlement.append(token_id)
        
        if skipped_count > 0:
            print(f"   ✅ 已跳过 {skipped_count} 个预测失败的 token")

    # ========== 步骤3.5：确定需要处理的 token ==========
    tokens_to_process = new_tokens.intersection(tokens_to_check_settlement)

    # ========== 步骤4：对剩余 token 检查 redeemable 并执行 redeem ==========
    if not tokens_to_process:
        print("   本轮没有需要 redeem 的 token。")
        return
    
    print(f"\n🎯 开始处理 {len(tokens_to_process)} 个待 redeem 的 token...")
    
    # 按 condition_id 聚合
    by_condition: Dict[str, dict] = {}
    
    for token_id in tokens_to_process:
        pos_info = position_map[token_id]
        cond_id = pos_info["condition_id"]
        
        if cond_id not in by_condition:
            by_condition[cond_id] = {
                "redeemable": False,
                "tokens": [],
                "title": pos_info["title"],
                "slug": pos_info.get("slug")
            }
        
        by_condition[cond_id]["tokens"].append({
            "token_id": token_id,
            "outcome_index": pos_info["outcome_index"],
            "condition_id": cond_id,
            "size": pos_info["size"]
        })
        
        if pos_info["redeemable"]:
            by_condition[cond_id]["redeemable"] = True

    # 执行 redeem（并发提交，异步验证）
    redeemed_count = 0
    verification_threads = []
    attempted_tokens: Dict[str, dict] = {}  # token_id -> {cond_id, path}

    for cond_id, info in by_condition.items():
        if not info["redeemable"]:
            # Data API 没标记为 redeemable，说明还没到可 redeem 状态
            print(f"   ⏳ 未到可领取时间: {info['title']}")
            continue

        print(f"\n💰 发现可领取市场: {info['title']}")
        print(f"   Condition ID: {cond_id}")

        # 额外验证：检查 outcome prices 是否有获胜者
        market = fetch_market_details(cond_id, info.get("slug"))
        if market:
            outcome_prices = market.get("outcomePrices", [])
            if isinstance(outcome_prices, str):
                try:
                    import json
                    outcome_prices = json.loads(outcome_prices)
                except Exception:
                    outcome_prices = []
            
            # 检查是否有 outcome 价格为 1.0（真正 settled）
            has_winner = False
            for price in outcome_prices:
                try:
                    if float(price) == 1.0:
                        has_winner = True
                        break
                except (ValueError, TypeError):
                    pass
            
            if not has_winner:
                print(f"   ⚠️ 市场虽标记为 redeemable，但链上尚未 settle（所有 outcome prices 都不是 1.0）")
                print(f"   跳过此市场，等待 UMA Oracle 完成最终 settlement")
                continue

        # 路径强制走 CTF，后续失败再交叉重试
        path = "ctf"
        print("   📋 路径: CTF（强制首选）")

        try:
            if path == "adapter":
                # 走 NegRiskAdapter：amounts = [yes_amount, no_amount]
                yes_amount = 0
                no_amount = 0
                for token_info in info["tokens"]:
                    outcome_idx = int(token_info["outcome_index"])
                    token_size = token_info.get("size", 0)
                    try:
                        size_float = float(token_size)
                        size_wei = int(size_float * 1e6)  # USDC 6 decimals
                    except (ValueError, TypeError):
                        size_wei = 0
                    if outcome_idx == 0:
                        yes_amount += size_wei
                    elif outcome_idx == 1:
                        no_amount += size_wei
                    else:
                        print(f"   ⚠️ 非预期 outcome_index {outcome_idx}，amounts 将忽略该条")
                amounts = [yes_amount, no_amount]
                print(f"   📋 NegRisk amounts: {amounts}")

                data = encode_neg_risk_redeem_data(cond_id, amounts)
                tx = SafeTransaction(
                    to=REDEEMER_ADDRESS,
                    value="0",
                    data=data,
                    operation=OperationType.Call,
                )
                print("   🚀 发送领取交易给 Relayer（NegRiskAdapter，多元/负风险）...")
            else:
                # 二元市场：继续走 CTF
                parent_collection_id = (
                    (market.get("parentCollectionId") if market else None)
                    or (market.get("parentCollectionID") if market else None)
                    or PARENT_COLLECTION_ID
                )

                derived_index_sets = set()
                for token_info in info["tokens"]:
                    token_id = token_info.get("token_id")
                    idx = derive_index_set_from_token(token_id, cond_id, parent_collection_id)
                    if idx:
                        derived_index_sets.add(idx)

                if derived_index_sets:
                    index_sets = sorted(list(derived_index_sets))
                else:
                    outcome_indices = set()
                    for token_info in info["tokens"]:
                        outcome_indices.add(int(token_info["outcome_index"]))
                    index_sets = [1 << i for i in outcome_indices]
                    index_sets.sort()

                print(f"   📋 parentCollectionId: {parent_collection_id}")
                print(f"   📋 计算的 Index Sets: {index_sets}")

                data = encode_redeem_data(cond_id, index_sets, parent_collection_id)
                tx = SafeTransaction(
                    to=CTF_ADDRESS,
                    value="0",
                    data=data,
                    operation=OperationType.Call,
                )
                print("   🚀 发送领取交易给 Relayer（标准 CTF，二元）...")

            resp = client.execute([tx])
            tx_hash = getattr(resp, "transaction_hash", None) or str(resp)
            print(f"   📤 交易已提交: {tx_hash[:20]}...")

            redeemed_count += 1

            # 为每个 token 启动后台线程验证交易结果
            for token_info in info["tokens"]:
                attempted_tokens[token_info["token_id"]] = {
                    "cond_id": cond_id,
                    "path": path,
                }
                thread = threading.Thread(
                    target=process_redeem_result,
                    args=(wallet_id, token_info, tx_hash, wallet_name),
                    daemon=True
                )
                thread.start()
                verification_threads.append(thread)

        except Exception as e:
            print(f"   ❌ 领取失败: {e}")

    if redeemed_count == 0:
        print("   本轮没有成功提交 redeem 操作。")
    else:
        print(f"\n✅ 本轮成功提交 {redeemed_count} 个市场的 redeem 操作！")
        print(f"   后台正在验证 {len(verification_threads)} 个交易...")
        print(f"   （验证将在后台自动完成，通常需要 5-15 秒）")

    # 等待后台验证完成后，检查是否需要交叉重试
    for t in verification_threads:
        t.join()

    if attempted_tokens:
        # 等待数据源刷新
        print("   ⏳ 等待 15 秒以刷新持仓数据后再检查...")
        time.sleep(15)
        # 重新获取持仓
        remaining_positions = fetch_user_positions(user_address) or []
        remaining_token_ids = set()
        for p in remaining_positions:
            token_id = p.get("asset") or p.get("token_id")
            if token_id:
                remaining_token_ids.add(token_id)

        retry_tokens = remaining_token_ids.intersection(set(attempted_tokens.keys()))
        if retry_tokens:
            print(f"\n🔁 发现 {len(retry_tokens)} 个 token 仍未赎回，尝试使用另一条路径重试...")

            # 准备当前 position_map 供重试使用
            retry_position_map: Dict[str, dict] = {}
            for p in remaining_positions:
                token_id = p.get("asset") or p.get("token_id")
                if token_id and token_id in retry_tokens:
                    retry_position_map[token_id] = {
                        "condition_id": p.get("conditionId"),
                        "outcome_index": p.get("outcomeIndex"),
                        "title": p.get("title") or p.get("slug") or "",
                        "slug": p.get("slug") or p.get("eventSlug"),
                        "redeemable": p.get("redeemable", False),
                        "size": p.get("size", 0),
                        "token_id": token_id,
                    }

            # 按 condition 聚合，路径为反向路径
            retry_by_condition: Dict[str, dict] = {}
            for token_id in retry_tokens:
                prev = attempted_tokens.get(token_id)
                if not prev:
                    continue
                cond_id = prev["cond_id"]
                new_path = "adapter" if prev["path"] == "ctf" else "ctf"
                if cond_id not in retry_by_condition:
                    retry_by_condition[cond_id] = {
                        "tokens": [],
                        "path": new_path,
                        "title": retry_position_map[token_id]["title"],
                        "slug": retry_position_map[token_id].get("slug"),
                    }
                retry_by_condition[cond_id]["tokens"].append(retry_position_map[token_id])

            retry_threads = []
            retry_redeemed = 0

            for cond_id, info in retry_by_condition.items():
                path = info["path"]
                print(f"\n🔁 重试市场: {info['title']} ({cond_id})，路径: {'NegRiskAdapter' if path=='adapter' else 'CTF'}")
                market = fetch_market_details(cond_id, info.get("slug"))

                try:
                    if path == "adapter":
                        yes_amount = 0
                        no_amount = 0
                        for token_info in info["tokens"]:
                            outcome_idx = int(token_info["outcome_index"])
                            token_size = token_info.get("size", 0)
                            try:
                                size_float = float(token_size)
                                size_wei = int(size_float * 1e6)
                            except (ValueError, TypeError):
                                size_wei = 0
                            if outcome_idx == 0:
                                yes_amount += size_wei
                            elif outcome_idx == 1:
                                no_amount += size_wei
                        amounts = [yes_amount, no_amount]
                        print(f"   📋 重试 NegRisk amounts: {amounts}")
                        data = encode_neg_risk_redeem_data(cond_id, amounts)
                        tx = SafeTransaction(
                            to=REDEEMER_ADDRESS,
                            value="0",
                            data=data,
                            operation=OperationType.Call,
                        )
                        print("   🚀 重试提交给 Relayer（NegRiskAdapter）...")
                    else:
                        parent_collection_id = (
                            (market.get("parentCollectionId") if market else None)
                            or (market.get("parentCollectionID") if market else None)
                            or PARENT_COLLECTION_ID
                        )
                        derived_index_sets = set()
                        for token_info in info["tokens"]:
                            token_id = token_info.get("token_id")
                            idx = derive_index_set_from_token(token_id, cond_id, parent_collection_id)
                            if idx:
                                derived_index_sets.add(idx)
                        if derived_index_sets:
                            index_sets = sorted(list(derived_index_sets))
                        else:
                            outcome_indices = set()
                            for token_info in info["tokens"]:
                                outcome_indices.add(int(token_info["outcome_index"]))
                            index_sets = [1 << i for i in outcome_indices]
                            index_sets.sort()
                        print(f"   📋 重试 parentCollectionId: {parent_collection_id}")
                        print(f"   📋 重试 Index Sets: {index_sets}")
                        data = encode_redeem_data(cond_id, index_sets, parent_collection_id)
                        tx = SafeTransaction(
                            to=CTF_ADDRESS,
                            value="0",
                            data=data,
                            operation=OperationType.Call,
                        )
                        print("   🚀 重试提交给 Relayer（CTF）...")

                    resp = client.execute([tx])
                    tx_hash = getattr(resp, "transaction_hash", None) or str(resp)
                    print(f"   📤 重试交易已提交: {tx_hash[:20]}...")
                    retry_redeemed += 1

                    for token_info in info["tokens"]:
                        thread = threading.Thread(
                            target=process_redeem_result,
                            args=(wallet_id, token_info, tx_hash, wallet_name),
                            daemon=True
                        )
                        thread.start()
                        retry_threads.append(thread)
                except Exception as e:
                    print(f"   ❌ 重试领取失败: {e}")

            for t in retry_threads:
                t.join()

            # 等待数据源刷新
            print("   ⏳ 等待 15 秒以刷新持仓数据后再检查...")
            time.sleep(15)

            # 重试后再检查一次持仓
            final_positions = fetch_user_positions(user_address) or []
            final_tokens = set()
            for p in final_positions:
                token_id = p.get("asset") or p.get("token_id")
                if token_id:
                    final_tokens.add(token_id)

            still_failed = set(attempted_tokens.keys()).intersection(final_tokens)
            if still_failed:
                print(f"\n⚠️  以下 token 两次尝试均未成功赎回（请人工检查）：")
                for tid in still_failed:
                    info = retry_position_map.get(tid) or position_map.get(tid)
                    if info:
                        print(f"   - token_id: {tid}, condition: {info.get('condition_id')}, market: {info.get('title')}")
                    else:
                        print(f"   - token_id: {tid}")
            else:
                print("\n✅ 所有尝试的 token 已在两轮内成功赎回。")


def claim_loop():
    """持续运行，每隔 SCAN_INTERVAL 秒自动扫描并领取所有配置的钱包。"""

    print("💰 自动 Claim 机器人启动 (Gasless) - 多钱包版本")
    print(f"⏱️  扫描间隔: {SCAN_INTERVAL} 秒 ({SCAN_INTERVAL/3600:.1f} 小时)")
    print(f"🔍 正在检测 .env 文件中的钱包配置（最多 {MAX_WALLETS} 个）...")
    print("-" * 80)
    
    # 从环境变量中加载钱包配置
    wallet_configs = load_wallet_configs()
    
    if not wallet_configs:
        print("\n❌ 没有找到有效的钱包配置，退出程序")
        print("   请确保 .env 文件中包含以下格式的配置:")
        print("   WALLET_X_PRIVATE_KEY=你的私钥")
        print("   WALLET_X_PROXY_ADDRESS=你的代理地址")
        print("   (X 为 1 到 10 的整数)")
        return
    
    print(f"\n📋 成功加载 {len(wallet_configs)} 个钱包配置")
    
    # 为每个钱包添加 wallet_id
    for i, config in enumerate(wallet_configs, 1):
        config["wallet_id"] = str(i)

    while True:
        print(f"\n🕒 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} 开始新一轮扫描...")
        
        # 按顺序处理每个钱包
        for config in wallet_configs:
            try:
                # 为每个钱包创建独立的客户端
                client = get_relayer_client(config["private_key"])
                if not client:
                    print(f"❌ {config['name']} - 无法创建 Relayer 客户端，跳过")
                    continue
                
                # 执行 claim
                claim_once(
                    client=client,
                    user_address=config["proxy_address"],
                    wallet_name=config["name"],
                    wallet_id=config["wallet_id"]
                )
                
            except Exception as e:
                print(f"❌ {config['name']} - 处理过程出现异常: {e}")
                import traceback
                traceback.print_exc()
            
            # 钱包之间添加短暂延迟，避免请求过快
            if config != wallet_configs[-1]:  # 不是最后一个钱包
                print(f"\n⏳ 等待 5 秒后处理下一个钱包...")
                time.sleep(5)
        
        print(f"\n{'='*80}")
        print(f"✅ 本轮扫描完成！")
        print(f"⏳ 休眠 {SCAN_INTERVAL} 秒 ({SCAN_INTERVAL/3600:.1f} 小时) 后进行下一次扫描...")
        mel_tz = ZoneInfo("Australia/Melbourne")
        next_scan_time = datetime.now(mel_tz) + timedelta(seconds=SCAN_INTERVAL)
        next_scan_str = next_scan_time.strftime("%Y-%m-%d %H:%M:%S %Z")
        print(f"🕓 下次扫描时间（墨尔本）: {next_scan_str}")
        print(f"{'='*80}\n")
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    claim_loop()
