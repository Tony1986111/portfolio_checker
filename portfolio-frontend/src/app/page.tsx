'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTheme } from 'next-themes'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8405'

// 硬编码钱包名字
const WALLET_NAMES: Record<string, string> = {
  '1': '1-Sports',
  '2': '2-ETH',
  '3': '3-BTC',
  '4': '4-SOL',
  '5': '5-XRP',
  '6': '6-1分钱',
}

interface WalletData {
  proxy_address: string
  usdc_balance: number
  positions_value: number
  portfolio_total: number
  last_updated: number
}

interface HistoryEntry {
  timestamp: number
  total: number
  wallets: Record<string, number>
}

interface WalletConfig {
  wallet_id: string
  name: string
  proxy_address: string
}

const COLORS = ['#60a5fa', '#4ade80', '#f472b6', '#facc15', '#a78bfa', '#fb923c']

const TIME_RANGES = [
  { label: '10m', value: 10 * 60 * 1000 },
  { label: '30m', value: 30 * 60 * 1000 },
  { label: '1h', value: 60 * 60 * 1000 },
  { label: '1D', value: 24 * 60 * 60 * 1000 },
  { label: '3D', value: 3 * 24 * 60 * 60 * 1000 },
  { label: '1W', value: 7 * 24 * 60 * 60 * 1000 },
  { label: '1M', value: 30 * 24 * 60 * 60 * 1000 },
]

export default function Home() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [wallets, setWallets] = useState<WalletData[]>([])
  const [walletConfigs, setWalletConfigs] = useState<WalletConfig[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedRange, setSelectedRange] = useState('1h')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  // 加载缓存数据（快速）
  const loadCachedData = useCallback(async () => {
    try {
      const [configRes, cachedRes, historyRes] = await Promise.all([
        fetch(`${API_BASE}/api/wallets`),
        fetch(`${API_BASE}/api/portfolio/cached`),
        fetch(`${API_BASE}/api/portfolio/history`)
      ])
      
      if (configRes.ok) {
        setWalletConfigs(await configRes.json())
      }
      if (cachedRes.ok) {
        const data = await cachedRes.json()
        const walletList = data.wallets || []
        setWallets(walletList)
        // 从缓存数据中获取最新更新时间
        if (walletList.length > 0) {
          const latestTs = Math.max(...walletList.map((w: WalletData) => w.last_updated))
          setLastUpdated(new Date(latestTs))
        }
      }
      if (historyRes.ok) {
        setHistory(await historyRes.json())
      }
    } catch (err) {
      console.error('加载缓存数据失败:', err)
    }
  }, [])

  // 刷新数据（慢，需要调用外部API）
  const refreshData = useCallback(async () => {
    setLoading(true)
    try {
      const refreshRes = await fetch(`${API_BASE}/api/portfolio/refresh`)
      if (refreshRes.ok) {
        const data = await refreshRes.json()
        setWallets(data.data || [])
        setLastUpdated(new Date())
        // 刷新后重新获取历史数据
        const historyRes = await fetch(`${API_BASE}/api/portfolio/history`)
        if (historyRes.ok) {
          setHistory(await historyRes.json())
        }
      }
    } catch (err) {
      console.error('刷新数据失败:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadCachedData() // 页面加载时只加载缓存
    const interval = setInterval(refreshData, 10 * 60 * 1000) // 自动刷新
    return () => clearInterval(interval)
  }, [loadCachedData, refreshData])

  const totalPortfolio = wallets.reduce((sum, w) => sum + w.portfolio_total, 0)
  const totalUsdc = wallets.reduce((sum, w) => sum + w.usdc_balance, 0)
  const totalPositions = wallets.reduce((sum, w) => sum + w.positions_value, 0)

  const filteredHistory = useMemo(() => {
    const range = TIME_RANGES.find(r => r.label === selectedRange)
    if (!range) return history
    const cutoff = Date.now() - range.value
    return history.filter(h => h.timestamp >= cutoff)
  }, [history, selectedRange])

  // 获取钱包名字（使用硬编码）
  const getWalletName = useCallback((walletId: string) => {
    return WALLET_NAMES[walletId] || `钱包 ${walletId}`
  }, [])

  const chartData = useMemo(() => {
    return filteredHistory.map(h => {
      const entry: Record<string, string | number> = {
        time: new Date(h.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        timestamp: h.timestamp
      }
      walletConfigs.forEach((config, idx) => {
        if (h.wallets[config.proxy_address] !== undefined) {
          entry[`wallet_${idx + 1}`] = h.wallets[config.proxy_address]
        }
      })
      return entry
    })
  }, [filteredHistory, walletConfigs])

  if (!mounted) return null

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) => {
    if (!active || !payload) return null
    return (
      <div className="bg-[#1a1a2e] border border-[#2a2a3e] rounded-lg p-3 shadow-xl">
        <p className="text-xs text-gray-400 mb-2">{label}</p>
        {payload.map((entry, idx) => (
          <div key={idx} className="flex items-center gap-2 text-sm">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
            <span className="text-gray-300">{entry.name}:</span>
            <span className="font-semibold text-white">${entry.value.toFixed(2)}</span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <main className="h-screen flex flex-col bg-[var(--background)]">
      {/* 顶部栏 */}
      <header className="flex justify-between items-center px-6 py-4 border-b border-[var(--border)]">
        <h1 className="text-xl font-bold">Portfolio Checker</h1>
        <div className="flex gap-3 items-center">
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="px-3 py-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--card-bg)] transition text-sm"
          >
            {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
          </button>
          <button
            onClick={refreshData}
            disabled={loading}
            className="px-4 py-1.5 rounded-lg bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 transition text-sm"
          >
            {loading ? '刷新中...' : '↻ 刷新'}
          </button>
        </div>
      </header>

      {/* 主内容区 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧钱包列表 */}
        <aside className="w-72 border-r border-[var(--border)] overflow-y-auto p-4">
          <h2 className="text-sm font-semibold text-[var(--muted)] mb-3">钱包列表</h2>
          <div className="space-y-2">
            {walletConfigs.map((config, idx) => {
              const wallet = wallets.find(w => w.proxy_address === config.proxy_address)
              if (!wallet) return null
              return (
                <div
                  key={wallet.proxy_address}
                  className="p-3 rounded-xl bg-[var(--card-bg)]"
                  style={{ borderLeft: `4px solid ${COLORS[idx % COLORS.length]}` }}
                >
                  {/* 第一行：名字和总资产 */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[idx % COLORS.length] }} />
                      <span className="text-sm font-semibold">{getWalletName(config.wallet_id)}</span>
                    </div>
                    <div className="text-lg font-bold text-[var(--success)]">
                      ${wallet.portfolio_total.toFixed(2)}
                    </div>
                  </div>
                  {/* 第二行：USDC和持仓 */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-[var(--background)] rounded-lg p-2">
                      <div className="text-[10px] text-[var(--muted)] mb-0.5">USDC</div>
                      <div className="text-sm font-bold text-[var(--accent)]">${wallet.usdc_balance.toFixed(2)}</div>
                    </div>
                    <div className="bg-[var(--background)] rounded-lg p-2">
                      <div className="text-[10px] text-[var(--muted)] mb-0.5">持仓</div>
                      <div className="text-sm font-bold text-[var(--foreground)]">${wallet.positions_value.toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </aside>

        {/* 右侧主区域 */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 图表区域 */}
          <div className="flex-1 p-6 flex flex-col">
            {/* 图表头部 */}
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-4">
                <h2 className="text-lg font-semibold">资产总览</h2>
                {lastUpdated && (
                  <div className="text-sm font-bold text-[var(--foreground)]">
                    {lastUpdated.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} {lastUpdated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </div>
                )}
              </div>
              {/* 时间范围选择 */}
              <div className="flex gap-1 bg-[var(--card-bg)] rounded-lg p-1 border border-[var(--border)]">
                {TIME_RANGES.map(range => (
                  <button
                    key={range.label}
                    onClick={() => setSelectedRange(range.label)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                      selectedRange === range.label
                        ? 'bg-[var(--accent)] text-white shadow-sm'
                        : 'text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--border)]'
                    }`}
                  >
                    {range.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 图例 */}
            <div className="flex flex-wrap gap-4 mb-4">
              {walletConfigs.map((config, idx) => (
                <div key={config.proxy_address} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[idx % COLORS.length] }} />
                  <span className="text-xs text-[var(--muted)]">{getWalletName(config.wallet_id)}</span>
                </div>
              ))}
            </div>

            {/* 图表 */}
            <div className="flex-1 bg-gradient-to-b from-[var(--card-bg)] to-[var(--background)] rounded-xl border border-[var(--border)] p-4 min-h-0">
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      {walletConfigs.map((_, idx) => (
                        <linearGradient key={idx} id={`gradient_${idx}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={COLORS[idx % COLORS.length]} stopOpacity={0.3} />
                          <stop offset="100%" stopColor={COLORS[idx % COLORS.length]} stopOpacity={0} />
                        </linearGradient>
                      ))}
                    </defs>
                    <XAxis
                      dataKey="time"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: 'var(--muted)', fontSize: 11 }}
                      dy={10}
                      type="category"
                      allowDuplicatedCategory={false}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: 'var(--muted)', fontSize: 11 }}
                      tickFormatter={(v) => `$${v}`}
                      dx={-10}
                      width={60}
                      domain={['auto', 'auto']}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    {walletConfigs.map((config, idx) => (
                      <Area
                        key={config.proxy_address}
                        type="linear"
                        dataKey={`wallet_${idx + 1}`}
                        name={getWalletName(config.wallet_id)}
                        stroke={COLORS[idx % COLORS.length]}
                        strokeWidth={chartData.length > 1 ? 2 : 0}
                        fill={chartData.length > 1 ? `url(#gradient_${idx})` : 'transparent'}
                        dot={{ r: 4, fill: COLORS[idx % COLORS.length], strokeWidth: 0 }}
                        activeDot={{ r: 6, strokeWidth: 2, fill: 'var(--background)', stroke: COLORS[idx % COLORS.length] }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-[var(--muted)]">
                  暂无数据，点击刷新获取
                </div>
              )}
            </div>
          </div>

          {/* 底部统计栏 */}
          <div className="border-t border-[var(--border)] bg-[var(--card-bg)]">
            <div className="flex">
              <div className="flex-1 px-6 py-4 border-r border-[var(--border)]">
                <div className="text-xs text-[var(--muted)] mb-1">总资产</div>
                <div className="text-xl font-bold text-[var(--success)]">${totalPortfolio.toFixed(2)}</div>
              </div>
              <div className="flex-1 px-6 py-4 border-r border-[var(--border)]">
                <div className="text-xs text-[var(--muted)] mb-1">USDC 余额</div>
                <div className="text-xl font-bold">${totalUsdc.toFixed(2)}</div>
              </div>
              <div className="flex-1 px-6 py-4">
                <div className="text-xs text-[var(--muted)] mb-1">持仓价值</div>
                <div className="text-xl font-bold">${totalPositions.toFixed(2)}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
