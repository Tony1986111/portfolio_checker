'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTheme } from 'next-themes'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Brush } from 'recharts'

const API_BASE = ''

// 默认钱包名字
const DEFAULT_WALLET_NAMES: Record<string, string> = {
  '1': '1-Sports',
  '2': '2-BTC-5m-10s',
  '3': '3-BTC-5m-5s',
  '4': '4-BTC-5m-3s',
  '5': '5-BTC-5m-0s',
  '6': '6-1分钱',
  '7': '7-BTC-0s',
  '8': '8-BTC-2x',
  '9': 'Poly-9-BTC-15m-5s',
  '10': 'Poly-10-BTC-15m-3s',
  '11': 'Poly-11-BTC-15m-1s',
}

// 默认偏移量
const DEFAULT_OFFSETS: Record<string, number> = {
  '1': 0,
  '2': 0,
  '3': 200,
  '4': 400,
  '5': 600,
  '6': 0,
  '7': 0,
  '8': -10,
  '9': -25,
  '10': -45,
  '11': -70,
}

// 自定义 Dot 组件 - 用于高亮增加的点
const CustomDot = (props: any) => {
  const { cx, cy, payload, dataKey, fill, walletId } = props
  const isIncreased = payload[`${dataKey}_increased`]
  
  // 根据钱包ID确定形状
  let shape = 'circle' // 默认圆形 (钱包1, 6)
  if (walletId >= 2 && walletId <= 5) {
    shape = 'diamond' // 钱包2-5: 菱形
  } else if (walletId >= 7 && walletId <= 11) {
    shape = 'square' // 钱包7-11: 正方形
  }
  
  if (!isIncreased) {
    // 普通点
    if (shape === 'diamond') {
      return (
        <rect
          x={cx - 4}
          y={cy - 4}
          width={8}
          height={8}
          fill={fill}
          transform={`rotate(45 ${cx} ${cy})`}
        />
      )
    } else if (shape === 'square') {
      return (
        <rect
          x={cx - 4}
          y={cy - 4}
          width={8}
          height={8}
          fill={fill}
        />
      )
    } else {
      return (
        <circle
          cx={cx}
          cy={cy}
          r={4}
          fill={fill}
          strokeWidth={0}
        />
      )
    }
  }
  
  // 增加的点 - 更大、多层
  if (shape === 'diamond') {
    return (
      <g>
        <rect x={cx - 10} y={cy - 10} width={20} height={20} fill={fill} opacity={0.3} transform={`rotate(45 ${cx} ${cy})`} />
        <rect x={cx - 7} y={cy - 7} width={14} height={14} fill={fill} opacity={0.6} transform={`rotate(45 ${cx} ${cy})`} />
        <rect x={cx - 5} y={cy - 5} width={10} height={10} fill={fill} stroke="#fff" strokeWidth={2} transform={`rotate(45 ${cx} ${cy})`} />
      </g>
    )
  } else if (shape === 'square') {
    return (
      <g>
        <rect x={cx - 10} y={cy - 10} width={20} height={20} fill={fill} opacity={0.3} />
        <rect x={cx - 7} y={cy - 7} width={14} height={14} fill={fill} opacity={0.6} />
        <rect x={cx - 5} y={cy - 5} width={10} height={10} fill={fill} stroke="#fff" strokeWidth={2} />
      </g>
    )
  } else {
    return (
      <g>
        <circle cx={cx} cy={cy} r={10} fill={fill} opacity={0.3} />
        <circle cx={cx} cy={cy} r={7} fill={fill} opacity={0.6} />
        <circle cx={cx} cy={cy} r={5} fill={fill} stroke="#fff" strokeWidth={2} />
      </g>
    )
  }
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
  total_usdc: number
  total_positions: number
  total_portfolio: number
  wallets: Record<string, number>
}

interface WalletConfig {
  wallet_id: string
  name: string
  proxy_address: string
}

const COLORS = ['#60a5fa', '#4ade80', '#f472b6', '#facc15', '#a78bfa', '#fb923c']

// 默认颜色映射
const DEFAULT_COLORS: Record<string, string> = {
  '1': '#60a5fa',
  '2': '#4ade80',
  '3': '#f472b6',
  '4': '#facc15',
  '5': '#a78bfa',
  '6': '#fb923c',
  '7': '#60a5fa',
  '8': '#4ade80',
  '9': '#f472b6',
  '10': '#facc15',
  '11': '#a78bfa',
}

// 总计线的颜色
const TOTAL_COLORS = {
  portfolio: '#ffffff',  // 白色 - 总资产
  usdc: '#22d3ee',       // 青色 - 总USDC
  positions: '#f97316',  // 橙色 - 总持仓
}

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
  const [selectedRange, setSelectedRange] = useState('1D')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [showTotals, setShowTotals] = useState(false)
  const [enableOffset, setEnableOffset] = useState(true)
  
  // 新增状态
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [hiddenWallets, setHiddenWallets] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('hiddenWallets')
      return saved ? new Set(JSON.parse(saved)) : new Set()
    }
    return new Set()
  })
  const [walletNames, setWalletNames] = useState<Record<string, string>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('walletNames')
      return saved ? JSON.parse(saved) : { ...DEFAULT_WALLET_NAMES }
    }
    return { ...DEFAULT_WALLET_NAMES }
  })
  const [walletOffsets, setWalletOffsets] = useState<Record<string, number>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('walletOffsets')
      return saved ? JSON.parse(saved) : { ...DEFAULT_OFFSETS }
    }
    return { ...DEFAULT_OFFSETS }
  })
  const [walletColors, setWalletColors] = useState<Record<string, string>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('walletColors')
      return saved ? JSON.parse(saved) : { ...DEFAULT_COLORS }
    }
    return { ...DEFAULT_COLORS }
  })
  const [editingWalletId, setEditingWalletId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState<string>('')
  const [showOffsetMenu, setShowOffsetMenu] = useState<string | null>(null)
  const [showColorPicker, setShowColorPicker] = useState<string | null>(null)
  const [brushDomain, setBrushDomain] = useState<[number, number] | null>(null)
  const [timezone, setTimezone] = useState<'local' | 'melbourne' | 'eastern'>('local')
  const [yAxisDomain, setYAxisDomain] = useState<[number, number]>([0.1, 5000])
  const [isDraggingYAxis, setIsDraggingYAxis] = useState<'top' | 'bottom' | null>(null)
  const [dragStartY, setDragStartY] = useState<number>(0)
  const [dragStartValue, setDragStartValue] = useState<number>(0)
  const [deleteDialog, setDeleteDialog] = useState<{
    show: boolean
    walletName: string
    timestamp: number
    proxyAddress: string
    value: number
  } | null>(null)
  
  // X轴拖动状态
  const [xAxisDomain, setXAxisDomain] = useState<[number, number] | null>(null)
  const [isDraggingXAxis, setIsDraggingXAxis] = useState<'left' | 'right' | null>(null)
  const [dragStartX, setDragStartX] = useState<number>(0)
  const [dragStartIndex, setDragStartIndex] = useState<number>(0)

  useEffect(() => {
    setMounted(true)
    // 设置默认日期为最近1天
    const end = new Date()
    const start = new Date(end.getTime() - 1 * 24 * 60 * 60 * 1000)
    setEndDate(end.toISOString().split('T')[0])
    setStartDate(start.toISOString().split('T')[0])
  }, [])

  // 保存隐藏状态到 localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('hiddenWallets', JSON.stringify([...hiddenWallets]))
    }
  }, [hiddenWallets])

  // 保存钱包名字到 localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('walletNames', JSON.stringify(walletNames))
    }
  }, [walletNames])

  // 保存偏移量到 localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('walletOffsets', JSON.stringify(walletOffsets))
    }
  }, [walletOffsets])

  // 保存颜色到 localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('walletColors', JSON.stringify(walletColors))
    }
  }, [walletColors])

  // 切换钱包显示/隐藏
  const toggleWalletVisibility = useCallback((proxyAddress: string) => {
    setHiddenWallets(prev => {
      const newSet = new Set(prev)
      if (newSet.has(proxyAddress)) {
        newSet.delete(proxyAddress)
      } else {
        newSet.add(proxyAddress)
      }
      return newSet
    })
  }, [])

  // 开始编辑钱包名字
  const startEditingName = useCallback((walletId: string) => {
    setEditingWalletId(walletId)
    setEditingName(walletNames[walletId] || DEFAULT_WALLET_NAMES[walletId] || '')
  }, [walletNames])

  // 保存钱包名字
  const saveWalletName = useCallback((walletId: string) => {
    if (editingName.trim()) {
      setWalletNames(prev => ({ ...prev, [walletId]: editingName.trim() }))
    }
    setEditingWalletId(null)
    setEditingName('')
  }, [editingName])

  // 取消编辑
  const cancelEditingName = useCallback(() => {
    setEditingWalletId(null)
    setEditingName('')
  }, [])

  // 更新偏移量
  const updateOffset = useCallback((walletId: string, offset: number) => {
    setWalletOffsets(prev => ({ ...prev, [walletId]: offset }))
  }, [])

  // 切换偏移菜单
  const toggleOffsetMenu = useCallback((walletId: string | null) => {
    setShowOffsetMenu(prev => prev === walletId ? null : walletId)
  }, [])

  // 更新颜色
  const updateColor = useCallback((walletId: string, color: string) => {
    setWalletColors(prev => ({ ...prev, [walletId]: color }))
  }, [])

  // 切换颜色选择器
  const toggleColorPicker = useCallback((walletId: string | null) => {
    setShowColorPicker(prev => prev === walletId ? null : walletId)
  }, [])

  // 获取钱包颜色
  const getWalletColor = useCallback((walletId: string) => {
    return walletColors[walletId] || DEFAULT_COLORS[walletId] || COLORS[0]
  }, [walletColors])

  // 根据选择的时间范围计算需要的小时数
  const getHoursForRange = useCallback((range: string) => {
    const rangeConfig = TIME_RANGES.find(r => r.label === range)
    if (!rangeConfig) return 24
    return Math.ceil(rangeConfig.value / (60 * 60 * 1000))
  }, [])

  // 加载缓存数据（快速）- 只在初始化时调用一次
  const loadCachedData = useCallback(async () => {
    try {
      const [configRes, cachedRes] = await Promise.all([
        fetch(`${API_BASE}/api/wallets`),
        fetch(`${API_BASE}/api/portfolio/cached`)
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
        const hours = getHoursForRange(selectedRange)
        const historyRes = await fetch(`${API_BASE}/api/portfolio/history?hours=${hours}`)
        if (historyRes.ok) {
          setHistory(await historyRes.json())
        }
      }
    } catch (err) {
      console.error('刷新数据失败:', err)
    } finally {
      setLoading(false)
    }
  }, [getHoursForRange, selectedRange])

  useEffect(() => {
    loadCachedData() // 页面加载时只加载缓存
    const interval = setInterval(refreshData, 10 * 60 * 1000) // 自动刷新
    return () => clearInterval(interval)
  }, [loadCachedData, refreshData])

  // 当时间范围改变时，重新获取历史数据
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const hours = getHoursForRange(selectedRange)
        const historyRes = await fetch(`${API_BASE}/api/portfolio/history?hours=${hours}`)
        if (historyRes.ok) {
          setHistory(await historyRes.json())
        }
      } catch (err) {
        console.error('获取历史数据失败:', err)
      }
    }
    fetchHistory()
  }, [selectedRange, getHoursForRange])

  const totalPortfolio = wallets.reduce((sum, w) => sum + w.portfolio_total, 0)
  const totalUsdc = wallets.reduce((sum, w) => sum + w.usdc_balance, 0)
  const totalPositions = wallets.reduce((sum, w) => sum + w.positions_value, 0)

  const filteredHistory = useMemo(() => {
    let filtered = history
    
    // 如果选择了自定义日期范围
    if (startDate && endDate) {
      const startTime = new Date(startDate).getTime()
      const endTime = new Date(endDate).getTime() + 24 * 60 * 60 * 1000 - 1 // 包含结束日期的全天
      filtered = history.filter(h => h.timestamp >= startTime && h.timestamp <= endTime)
    } else {
      // 否则使用预设时间范围
      const range = TIME_RANGES.find(r => r.label === selectedRange)
      if (range) {
        const cutoff = Date.now() - range.value
        filtered = history.filter(h => h.timestamp >= cutoff)
      }
    }
    
    return filtered
  }, [history, selectedRange, startDate, endDate])

  // 获取钱包名字
  const getWalletName = useCallback((walletId: string) => {
    return walletNames[walletId] || DEFAULT_WALLET_NAMES[walletId] || `钱包 ${walletId}`
  }, [walletNames])

  // 根据时间范围决定时间格式 - 每4小时显示一个标签
  const formatTime = useCallback((timestamp: number) => {
    const date = new Date(timestamp)
    let displayDate: Date
    
    // 根据选择的时区调整显示时间
    if (timezone === 'local') {
      // 使用本地时区
      displayDate = date
    } else if (timezone === 'melbourne') {
      // 墨尔本时区 UTC+11 (使用 toLocaleString 转换)
      const melbourneTime = date.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' })
      displayDate = new Date(melbourneTime)
    } else if (timezone === 'eastern') {
      // 美东时区 (使用 toLocaleString 转换)
      const easternTime = date.toLocaleString('en-US', { timeZone: 'America/New_York' })
      displayDate = new Date(easternTime)
    } else {
      displayDate = date
    }
    
    const range = TIME_RANGES.find(r => r.label === selectedRange)
    // 超过1天显示日期+时间，否则只显示时间
    if (range && range.value > 24 * 60 * 60 * 1000) {
      return `${displayDate.getMonth() + 1}/${displayDate.getDate()} ${displayDate.getHours().toString().padStart(2, '0')}:${displayDate.getMinutes().toString().padStart(2, '0')}`
    }
    return `${displayDate.getHours().toString().padStart(2, '0')}:${displayDate.getMinutes().toString().padStart(2, '0')}`
  }, [selectedRange, timezone])

  // 过滤时间标签，每4小时显示一个
  const getTickIndices = useCallback((data: any[]) => {
    if (data.length === 0) return []
    const indices: number[] = []
    const fourHours = 4 * 60 * 60 * 1000
    
    let lastTimestamp = 0
    data.forEach((item, idx) => {
      if (idx === 0 || item.timestamp - lastTimestamp >= fourHours) {
        indices.push(idx)
        lastTimestamp = item.timestamp
      }
    })
    
    return indices
  }, [])

  const chartData = useMemo(() => {
    // 用于存储每个钱包的前一个值
    const previousValues: Record<string, number> = {}
    
    return filteredHistory.map((h, historyIdx) => {
      const entry: Record<string, string | number | boolean> = {
        time: formatTime(h.timestamp),
        timestamp: h.timestamp,
        total_portfolio: h.total_portfolio || 0,
        total_usdc: h.total_usdc || 0,
        total_positions: h.total_positions || 0,
      }
      walletConfigs.forEach((config, idx) => {
        if (h.wallets[config.proxy_address] !== undefined) {
          const originalValue = h.wallets[config.proxy_address]
          let value = originalValue
          
          // 如果开启了偏移模式，应用该钱包的偏移量
          if (enableOffset) {
            const offset = walletOffsets[config.wallet_id] || 0
            value += offset
          }
          
          const walletKey = `wallet_${idx + 1}`
          entry[walletKey] = value
          // 保存原始值用于 tooltip 显示
          entry[`${walletKey}_original`] = originalValue
          
          // 检测是否增加（与前一个点比较）
          const prevKey = `${config.proxy_address}_prev`
          if (previousValues[prevKey] !== undefined && originalValue > previousValues[prevKey]) {
            entry[`${walletKey}_increased`] = true
          } else {
            entry[`${walletKey}_increased`] = false
          }
          
          // 更新前一个值
          previousValues[prevKey] = originalValue
        }
      })
      return entry
    })
  }, [filteredHistory, walletConfigs, formatTime, enableOffset, walletOffsets])

  // 根据 X 轴范围过滤数据
  const displayChartData = useMemo(() => {
    if (!xAxisDomain) return chartData
    const [start, end] = xAxisDomain
    return chartData.slice(start, end + 1)
  }, [chartData, xAxisDomain])

  // 处理 Y 轴拖动
  const handleYAxisMouseDown = useCallback((e: React.MouseEvent, position: 'top' | 'bottom') => {
    e.preventDefault()
    setIsDraggingYAxis(position)
    setDragStartY(e.clientY)
    setDragStartValue(position === 'top' ? yAxisDomain[1] : yAxisDomain[0])
  }, [yAxisDomain])

  const handleYAxisMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingYAxis) return
    
    const deltaY = dragStartY - e.clientY // 向上为正
    const sensitivity = 0.02 // 调整灵敏度
    
    // 使用对数比例计算新值
    const logChange = deltaY * sensitivity
    const multiplier = Math.exp(logChange)
    let newValue = dragStartValue * multiplier
    
    // 限制范围
    newValue = Math.max(0.01, Math.min(100000, newValue))
    
    if (isDraggingYAxis === 'top') {
      // 拖动顶部，确保顶部值大于底部值
      if (newValue > yAxisDomain[0] * 1.5) {
        setYAxisDomain([yAxisDomain[0], newValue])
      }
    } else {
      // 拖动底部，确保底部值小于顶部值
      if (newValue < yAxisDomain[1] / 1.5) {
        setYAxisDomain([newValue, yAxisDomain[1]])
      }
    }
  }, [isDraggingYAxis, dragStartY, dragStartValue, yAxisDomain])

  const handleYAxisMouseUp = useCallback(() => {
    setIsDraggingYAxis(null)
  }, [])

  // 执行删除操作
  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteDialog) return
    
    try {
      const response = await fetch(`${API_BASE}/api/portfolio/snapshot`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          proxy_address: deleteDialog.proxyAddress,
          timestamp: deleteDialog.timestamp,
        }),
      })
      
      const result = await response.json()
      
      if (result.success) {
        // 删除成功，重新获取历史数据
        const hours = getHoursForRange(selectedRange)
        const historyRes = await fetch(`${API_BASE}/api/portfolio/history?hours=${hours}`)
        if (historyRes.ok) {
          setHistory(await historyRes.json())
        }
      } else {
        alert(`删除失败: ${result.message}`)
      }
    } catch (err) {
      console.error('删除数据点失败:', err)
      alert('删除失败，请重试')
    } finally {
      setDeleteDialog(null)
    }
  }, [deleteDialog, getHoursForRange, selectedRange])

  // 取消删除
  const handleDeleteCancel = useCallback(() => {
    setDeleteDialog(null)
  }, [])

  useEffect(() => {
    if (isDraggingYAxis) {
      window.addEventListener('mousemove', handleYAxisMouseMove)
      window.addEventListener('mouseup', handleYAxisMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleYAxisMouseMove)
        window.removeEventListener('mouseup', handleYAxisMouseUp)
      }
    }
  }, [isDraggingYAxis, handleYAxisMouseMove, handleYAxisMouseUp])

  // 处理 X 轴拖动
  const handleXAxisMouseDown = useCallback((e: React.MouseEvent, position: 'left' | 'right') => {
    e.preventDefault()
    setIsDraggingXAxis(position)
    setDragStartX(e.clientX)
    
    const currentDomain = xAxisDomain || [0, chartData.length - 1]
    setDragStartIndex(position === 'left' ? currentDomain[0] : currentDomain[1])
  }, [xAxisDomain, chartData.length])

  const handleXAxisMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingXAxis || chartData.length === 0) return
    
    const deltaX = e.clientX - dragStartX
    const sensitivity = 0.1 // 调整灵敏度
    
    const indexChange = Math.round(deltaX * sensitivity)
    let newIndex = dragStartIndex + indexChange
    
    // 限制范围
    newIndex = Math.max(0, Math.min(chartData.length - 1, newIndex))
    
    const currentDomain = xAxisDomain || [0, chartData.length - 1]
    
    if (isDraggingXAxis === 'left') {
      // 拖动左边界，确保左边界小于右边界
      if (newIndex < currentDomain[1] - 5) { // 至少保留5个数据点
        setXAxisDomain([newIndex, currentDomain[1]])
      }
    } else {
      // 拖动右边界，确保右边界大于左边界
      if (newIndex > currentDomain[0] + 5) { // 至少保留5个数据点
        setXAxisDomain([currentDomain[0], newIndex])
      }
    }
  }, [isDraggingXAxis, dragStartX, dragStartIndex, xAxisDomain, chartData.length])

  const handleXAxisMouseUp = useCallback(() => {
    setIsDraggingXAxis(null)
  }, [])

  useEffect(() => {
    if (isDraggingXAxis) {
      window.addEventListener('mousemove', handleXAxisMouseMove)
      window.addEventListener('mouseup', handleXAxisMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleXAxisMouseMove)
        window.removeEventListener('mouseup', handleXAxisMouseUp)
      }
    }
  }, [isDraggingXAxis, handleXAxisMouseMove, handleXAxisMouseUp])

  if (!mounted) return null

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; dataKey: string; payload?: any }>; label?: string }) => {
    if (!active || !payload) return null
    
    return (
      <div className="bg-[#1a1a2e] border border-[#2a2a3e] rounded-lg p-3 shadow-xl">
        <p className="text-xs text-gray-400 mb-2">{label}</p>
        {payload.map((entry, idx) => {
          const dataKey = entry.dataKey as string
          const walletMatch = dataKey.match(/^wallet_(\d+)$/)
          let displayValue = entry.value
          
          // 如果开启了偏移且是钱包数据，显示原始值
          if (enableOffset && walletMatch) {
            const walletIdx = parseInt(walletMatch[1])
            const config = walletConfigs[walletIdx - 1]
            if (config && walletOffsets[config.wallet_id] !== undefined) {
              const originalKey = `${dataKey}_original`
              const dataPoint = (entry as any).payload
              if (dataPoint && dataPoint[originalKey] !== undefined) {
                displayValue = dataPoint[originalKey]
              }
            }
          }
          
          return (
            <div key={idx} className="flex items-center gap-2 text-sm">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
              <span className="text-gray-300">{entry.name}:</span>
              <span className="font-semibold text-white">${displayValue.toFixed(2)}</span>
            </div>
          )
        })}
        <p className="text-xs text-gray-400 mt-2 italic">💡 点击数据点可删除</p>
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
        {/* 左侧钱包列表 (1-6) */}
        <aside className="w-72 border-r border-[var(--border)] overflow-y-auto p-2">
          <h2 className="text-xs font-semibold text-[var(--muted)] mb-1.5">钱包 1-6</h2>
          <div className="space-y-1">
            {walletConfigs.filter((_, idx) => idx < 6).map((config, idx) => {
              const wallet = wallets.find(w => w.proxy_address === config.proxy_address)
              if (!wallet) return null
              const isEditing = editingWalletId === config.wallet_id
              const currentOffset = walletOffsets[config.wallet_id] || 0
              const currentColor = getWalletColor(config.wallet_id)
              
              return (
                <div
                  key={wallet.proxy_address}
                  className="p-1.5 rounded-md bg-[var(--card-bg)] relative"
                  style={{ borderLeft: `3px solid ${currentColor}` }}
                >
                  {/* 第一行：名字、按钮和总资产 */}
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      <div className="relative flex-shrink-0">
                        <div
                          className="w-3 h-3 rounded-full cursor-pointer hover:ring-2 hover:ring-[var(--accent)] transition-all"
                          style={{ backgroundColor: currentColor }}
                          onClick={() => toggleColorPicker(config.wallet_id)}
                          title="点击修改颜色"
                        />
                        {showColorPicker === config.wallet_id && (
                          <div className="absolute top-full left-0 mt-1 bg-[var(--card-bg)] border border-[var(--border)] rounded shadow-lg p-2 z-50 w-40">
                            <div className="text-[8px] text-[var(--muted)] mb-1">选择颜色</div>
                            <input
                              type="color"
                              value={currentColor}
                              onChange={(e) => updateColor(config.wallet_id, e.target.value)}
                              className="w-full h-8 cursor-pointer rounded"
                            />
                            <div className="grid grid-cols-6 gap-1 mt-2">
                              {['#60a5fa', '#4ade80', '#f472b6', '#facc15', '#a78bfa', '#fb923c', '#ef4444', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b'].map(color => (
                                <div
                                  key={color}
                                  className="w-6 h-6 rounded cursor-pointer hover:ring-2 hover:ring-white transition-all"
                                  style={{ backgroundColor: color }}
                                  onClick={() => updateColor(config.wallet_id, color)}
                                />
                              ))}
                            </div>
                            <button
                              onClick={() => setShowColorPicker(null)}
                              className="w-full mt-2 text-[8px] px-1 py-1 bg-[var(--accent)] text-white rounded hover:opacity-80"
                            >
                              关闭
                            </button>
                          </div>
                        )}
                      </div>
                      {isEditing ? (
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveWalletName(config.wallet_id)
                            if (e.key === 'Escape') cancelEditingName()
                          }}
                          onBlur={() => saveWalletName(config.wallet_id)}
                          autoFocus
                          className="text-xs font-semibold bg-[var(--background)] border border-[var(--accent)] rounded px-1 py-0.5 flex-1 min-w-0"
                        />
                      ) : (
                        <span
                          className="text-xs font-semibold cursor-pointer hover:text-[var(--accent)] truncate"
                          onClick={() => startEditingName(config.wallet_id)}
                          title="点击编辑名字"
                        >
                          {getWalletName(config.wallet_id)}
                        </span>
                      )}
                      <button
                        onClick={() => toggleWalletVisibility(wallet.proxy_address)}
                        className={`px-1 py-0.5 text-[8px] rounded transition-all flex-shrink-0 ${
                          hiddenWallets.has(wallet.proxy_address)
                            ? 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                            : 'bg-[var(--accent)] text-white hover:opacity-80'
                        }`}
                      >
                        {hiddenWallets.has(wallet.proxy_address) ? '隐藏' : '显示'}
                      </button>
                      <div className="relative flex-shrink-0">
                        <button
                          onClick={() => toggleOffsetMenu(config.wallet_id)}
                          className={`px-1 py-0.5 text-[8px] rounded transition-all ${
                            enableOffset
                              ? 'bg-orange-500 text-white hover:bg-orange-600'
                              : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                          }`}
                          title={`偏移: ${currentOffset}`}
                        >
                          ⇅
                        </button>
                        {showOffsetMenu === config.wallet_id && (
                          <div className="absolute top-full left-0 mt-1 bg-[var(--card-bg)] border border-[var(--border)] rounded shadow-lg p-2 z-50 w-32">
                            <div className="text-[8px] text-[var(--muted)] mb-1">偏移量</div>
                            <input
                              type="number"
                              value={currentOffset}
                              onChange={(e) => updateOffset(config.wallet_id, parseFloat(e.target.value) || 0)}
                              className="w-full text-xs bg-[var(--background)] border border-[var(--border)] rounded px-1 py-0.5"
                              step="1"
                            />
                            <div className="flex gap-1 mt-1">
                              <button
                                onClick={() => updateOffset(config.wallet_id, 0)}
                                className="flex-1 text-[8px] px-1 py-0.5 bg-gray-600 text-white rounded hover:bg-gray-500"
                              >
                                重置
                              </button>
                              <button
                                onClick={() => setShowOffsetMenu(null)}
                                className="flex-1 text-[8px] px-1 py-0.5 bg-[var(--accent)] text-white rounded hover:opacity-80"
                              >
                                关闭
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="text-sm font-bold text-[var(--success)] flex-shrink-0 ml-1">
                      ${wallet.portfolio_total.toFixed(2)}
                    </div>
                  </div>
                  {/* 第二行：USDC和持仓 */}
                  <div className="grid grid-cols-2 gap-1">
                    <div className="bg-[var(--background)] rounded p-1">
                      <div className="text-[8px] text-[var(--muted)] mb-0.5">USDC</div>
                      <div className="text-[11px] font-bold text-[var(--accent)]">${wallet.usdc_balance.toFixed(2)}</div>
                    </div>
                    <div className="bg-[var(--background)] rounded p-1">
                      <div className="text-[8px] text-[var(--muted)] mb-0.5">持仓</div>
                      <div className="text-[11px] font-bold text-[var(--foreground)]">${wallet.positions_value.toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </aside>

        {/* 中间主区域 */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 图表区域 */}
          <div className="flex-1 p-3 flex flex-col">
            {/* 图表头部 */}
            <div className="space-y-2 mb-2">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowTotals(!showTotals)}
                    title={showTotals ? '隐藏总计' : '显示总计'}
                    className={`px-2 py-1 text-xs rounded-md border transition-all ${
                      showTotals
                        ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                        : 'bg-transparent text-[var(--muted)] border-[var(--border)] hover:border-[var(--accent)]'
                    }`}
                  >
                    ∑
                  </button>
                  
                  <button
                    onClick={() => setEnableOffset(!enableOffset)}
                    title={enableOffset ? '偏移已开启' : '开启偏移'}
                    className={`px-2 py-1 text-xs rounded-md border transition-all ${
                      enableOffset
                        ? 'bg-orange-500 text-white border-orange-500'
                        : 'bg-transparent text-[var(--muted)] border-[var(--border)] hover:border-orange-500'
                    }`}
                  >
                    ⇅
                  </button>
                  
                  {/* 日期范围选择器 */}
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="px-2 py-1 text-xs rounded-md bg-[var(--background)] border border-[var(--border)] text-[var(--foreground)]"
                    />
                    <span className="text-xs text-[var(--muted)]">至</span>
                    <input
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="px-2 py-1 text-xs rounded-md bg-[var(--background)] border border-[var(--border)] text-[var(--foreground)]"
                    />
                    {startDate && endDate && (
                      <button
                        onClick={() => {
                          setStartDate('')
                          setEndDate('')
                        }}
                        title="清除日期范围"
                        className="px-2 py-1 text-xs rounded-md bg-gray-600 text-white hover:bg-gray-500 transition-all"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  
                  {/* 时区选择按钮 */}
                  <div className="flex gap-1 border border-[var(--border)] rounded-md p-0.5">
                    <button
                      onClick={() => setTimezone('local')}
                      title="当前时区"
                      className={`px-2 py-1 text-xs rounded transition-all ${
                        timezone === 'local'
                          ? 'bg-[var(--accent)] text-white'
                          : 'text-[var(--muted)] hover:text-[var(--foreground)]'
                      }`}
                    >
                      🏠
                    </button>
                    <button
                      onClick={() => setTimezone('melbourne')}
                      title="墨尔本时区"
                      className={`px-2 py-1 text-xs rounded transition-all ${
                        timezone === 'melbourne'
                          ? 'bg-[var(--accent)] text-white'
                          : 'text-[var(--muted)] hover:text-[var(--foreground)]'
                      }`}
                    >
                      🇦🇺
                    </button>
                    <button
                      onClick={() => setTimezone('eastern')}
                      title="美东时区"
                      className={`px-2 py-1 text-xs rounded transition-all ${
                        timezone === 'eastern'
                          ? 'bg-[var(--accent)] text-white'
                          : 'text-[var(--muted)] hover:text-[var(--foreground)]'
                      }`}
                    >
                      🇺🇸
                    </button>
                  </div>
                  
                  {brushDomain && (
                    <button
                      onClick={() => setBrushDomain(null)}
                      title="重置缩放"
                      className="px-2 py-1 text-xs rounded-md bg-orange-500 text-white hover:bg-orange-600 transition-all"
                    >
                      ↺
                    </button>
                  )}
                </div>
                {/* 时间范围选择 */}
                <div className="flex gap-1 bg-[var(--card-bg)] rounded-lg p-1 border border-[var(--border)]">
                  {TIME_RANGES.map(range => (
                    <button
                      key={range.label}
                      onClick={() => {
                        setSelectedRange(range.label)
                        setStartDate('')
                        setEndDate('')
                      }}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                        selectedRange === range.label && !startDate && !endDate
                          ? 'bg-[var(--accent)] text-white shadow-sm'
                          : 'text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--border)]'
                      }`}
                    >
                      {range.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 图表 */}
            <div className="flex-1 bg-gradient-to-b from-[var(--card-bg)] to-[var(--background)] rounded-xl border border-[var(--border)] p-2 min-h-0 relative">
              {/* Y轴拖动控制区域 - 顶部 */}
              <div
                className="absolute left-0 top-0 w-16 h-8 cursor-ns-resize z-10 flex items-center justify-center group"
                onMouseDown={(e) => handleYAxisMouseDown(e, 'top')}
                title="拖动调整Y轴上限"
              >
                <div className="text-xs text-[var(--muted)] group-hover:text-[var(--accent)] transition-colors">
                  ▲
                </div>
              </div>
              
              {/* Y轴拖动控制区域 - 底部 */}
              <div
                className="absolute left-0 bottom-0 w-16 h-8 cursor-ns-resize z-10 flex items-center justify-center group"
                onMouseDown={(e) => handleYAxisMouseDown(e, 'bottom')}
                title="拖动调整Y轴下限"
              >
                <div className="text-xs text-[var(--muted)] group-hover:text-[var(--accent)] transition-colors">
                  ▼
                </div>
              </div>
              
              {/* X轴拖动控制区域 - 左侧 */}
              <div
                className="absolute left-16 bottom-0 w-8 h-8 cursor-ew-resize z-10 flex items-center justify-center group"
                onMouseDown={(e) => handleXAxisMouseDown(e, 'left')}
                title="拖动调整X轴起点"
              >
                <div className="text-xs text-[var(--muted)] group-hover:text-[var(--accent)] transition-colors">
                  ◀
                </div>
              </div>
              
              {/* X轴拖动控制区域 - 右侧 */}
              <div
                className="absolute right-0 bottom-0 w-8 h-8 cursor-ew-resize z-10 flex items-center justify-center group"
                onMouseDown={(e) => handleXAxisMouseDown(e, 'right')}
                title="拖动调整X轴终点"
              >
                <div className="text-xs text-[var(--muted)] group-hover:text-[var(--accent)] transition-colors">
                  ▶
                </div>
              </div>
              
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart 
                    data={displayChartData} 
                    margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                  >
                    <defs>
                      {walletConfigs.map((config, idx) => {
                        const color = getWalletColor(config.wallet_id)
                        return (
                          <linearGradient key={idx} id={`gradient_${idx}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                            <stop offset="100%" stopColor={color} stopOpacity={0} />
                          </linearGradient>
                        )
                      })}
                    </defs>
                    <XAxis
                      dataKey="time"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: 'var(--muted)', fontSize: 11 }}
                      dy={10}
                      type="category"
                      allowDuplicatedCategory={false}
                      ticks={getTickIndices(displayChartData).map(idx => String(displayChartData[idx].time))}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: 'var(--muted)', fontSize: 11 }}
                      tickFormatter={(v) => `$${v}`}
                      dx={-10}
                      width={60}
                      scale="log" domain={yAxisDomain} allowDataOverflow
                    />
                    <Tooltip content={<CustomTooltip />} />
                    {brushDomain && (
                      <Brush
                        dataKey="time"
                        height={30}
                        stroke="var(--accent)"
                        startIndex={brushDomain[0]}
                        endIndex={brushDomain[1]}
                        onChange={(range) => {
                          if (range && range.startIndex !== undefined && range.endIndex !== undefined) {
                            setBrushDomain([range.startIndex, range.endIndex])
                          }
                        }}
                      />
                    )}
                    {/* 总计线 */}
                    {showTotals && (
                      <>
                        <Area
                          type="linear"
                          dataKey="total_portfolio"
                          name="总资产"
                          stroke={TOTAL_COLORS.portfolio}
                          strokeWidth={3}
                          fill="none"
                          dot={{ r: 3, fill: TOTAL_COLORS.portfolio, strokeWidth: 0 }}
                          activeDot={{ r: 5, strokeWidth: 2, fill: 'var(--background)', stroke: TOTAL_COLORS.portfolio }}
                          isAnimationActive={false}
                        />
                        <Area
                          type="linear"
                          dataKey="total_usdc"
                          name="总USDC"
                          stroke={TOTAL_COLORS.usdc}
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          fill="none"
                          dot={{ r: 3, fill: TOTAL_COLORS.usdc, strokeWidth: 0 }}
                          activeDot={{ r: 5, strokeWidth: 2, fill: 'var(--background)', stroke: TOTAL_COLORS.usdc }}
                          isAnimationActive={false}
                        />
                        <Area
                          type="linear"
                          dataKey="total_positions"
                          name="总持仓"
                          stroke={TOTAL_COLORS.positions}
                          strokeWidth={2}
                          strokeDasharray="3 3"
                          fill="none"
                          dot={{ r: 3, fill: TOTAL_COLORS.positions, strokeWidth: 0 }}
                          activeDot={{ r: 5, strokeWidth: 2, fill: 'var(--background)', stroke: TOTAL_COLORS.positions }}
                          isAnimationActive={false}
                        />
                      </>
                    )}
                    {/* 各钱包线 - 根据隐藏状态决定是否显示 */}
                    {walletConfigs.map((config, idx) => {
                      const isHidden = hiddenWallets.has(config.proxy_address)
                      if (isHidden) return null
                      
                      const walletIdNum = parseInt(config.wallet_id)
                      const walletColor = getWalletColor(config.wallet_id)
                      
                      return (
                        <Area
                          key={config.proxy_address}
                          type="linear"
                          dataKey={`wallet_${idx + 1}`}
                          name={getWalletName(config.wallet_id)}
                          stroke={walletColor}
                          strokeWidth={chartData.length > 1 ? 2 : 0}
                          fill={chartData.length > 1 ? `url(#gradient_${idx})` : 'transparent'}
                          dot={<CustomDot fill={walletColor} walletId={walletIdNum} />}
                          activeDot={{
                            r: 8,
                            strokeWidth: 2,
                            fill: 'var(--background)',
                            stroke: walletColor,
                            onClick: (e: any, payload: any) => {
                              const dataKey = `wallet_${idx + 1}`
                              const data = payload.payload
                              const walletName = getWalletName(config.wallet_id)
                              const timestamp = data.timestamp
                              let value = data[dataKey]
                              
                              // 如果开启了偏移，使用原始值
                              if (enableOffset && walletOffsets[config.wallet_id] !== undefined) {
                                const originalKey = `${dataKey}_original`
                                if (data[originalKey] !== undefined) {
                                  value = data[originalKey]
                                }
                              }
                              
                              setDeleteDialog({
                                show: true,
                                walletName,
                                timestamp,
                                proxyAddress: config.proxy_address,
                                value
                              })
                            }
                          }}
                          connectNulls={false}
                          isAnimationActive={false}
                        />
                      )
                    })}
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

        {/* 右侧钱包列表 (7-11) */}
        <aside className="w-72 border-l border-[var(--border)] overflow-y-auto p-2">
          <h2 className="text-xs font-semibold text-[var(--muted)] mb-1.5">钱包 7-11</h2>
          <div className="space-y-1">
            {walletConfigs.filter((_, idx) => idx >= 6).map((config, relativeIdx) => {
              const idx = relativeIdx + 6
              const wallet = wallets.find(w => w.proxy_address === config.proxy_address)
              if (!wallet) return null
              const isEditing = editingWalletId === config.wallet_id
              const currentOffset = walletOffsets[config.wallet_id] || 0
              const currentColor = getWalletColor(config.wallet_id)
              
              return (
                <div
                  key={wallet.proxy_address}
                  className="p-1.5 rounded-md bg-[var(--card-bg)] relative"
                  style={{ borderLeft: `3px solid ${currentColor}` }}
                >
                  {/* 第一行：名字、按钮和总资产 */}
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      <div className="relative flex-shrink-0">
                        <div
                          className="w-3 h-3 rounded-full cursor-pointer hover:ring-2 hover:ring-[var(--accent)] transition-all"
                          style={{ backgroundColor: currentColor }}
                          onClick={() => toggleColorPicker(config.wallet_id)}
                          title="点击修改颜色"
                        />
                        {showColorPicker === config.wallet_id && (
                          <div className="absolute top-full right-0 mt-1 bg-[var(--card-bg)] border border-[var(--border)] rounded shadow-lg p-2 z-50 w-40">
                            <div className="text-[8px] text-[var(--muted)] mb-1">选择颜色</div>
                            <input
                              type="color"
                              value={currentColor}
                              onChange={(e) => updateColor(config.wallet_id, e.target.value)}
                              className="w-full h-8 cursor-pointer rounded"
                            />
                            <div className="grid grid-cols-6 gap-1 mt-2">
                              {['#60a5fa', '#4ade80', '#f472b6', '#facc15', '#a78bfa', '#fb923c', '#ef4444', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b'].map(color => (
                                <div
                                  key={color}
                                  className="w-6 h-6 rounded cursor-pointer hover:ring-2 hover:ring-white transition-all"
                                  style={{ backgroundColor: color }}
                                  onClick={() => updateColor(config.wallet_id, color)}
                                />
                              ))}
                            </div>
                            <button
                              onClick={() => setShowColorPicker(null)}
                              className="w-full mt-2 text-[8px] px-1 py-1 bg-[var(--accent)] text-white rounded hover:opacity-80"
                            >
                              关闭
                            </button>
                          </div>
                        )}
                      </div>
                      {isEditing ? (
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveWalletName(config.wallet_id)
                            if (e.key === 'Escape') cancelEditingName()
                          }}
                          onBlur={() => saveWalletName(config.wallet_id)}
                          autoFocus
                          className="text-xs font-semibold bg-[var(--background)] border border-[var(--accent)] rounded px-1 py-0.5 flex-1 min-w-0"
                        />
                      ) : (
                        <span
                          className="text-xs font-semibold cursor-pointer hover:text-[var(--accent)] truncate"
                          onClick={() => startEditingName(config.wallet_id)}
                          title="点击编辑名字"
                        >
                          {getWalletName(config.wallet_id)}
                        </span>
                      )}
                      <button
                        onClick={() => toggleWalletVisibility(wallet.proxy_address)}
                        className={`px-1 py-0.5 text-[8px] rounded transition-all flex-shrink-0 ${
                          hiddenWallets.has(wallet.proxy_address)
                            ? 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                            : 'bg-[var(--accent)] text-white hover:opacity-80'
                        }`}
                      >
                        {hiddenWallets.has(wallet.proxy_address) ? '隐藏' : '显示'}
                      </button>
                      <div className="relative flex-shrink-0">
                        <button
                          onClick={() => toggleOffsetMenu(config.wallet_id)}
                          className={`px-1 py-0.5 text-[8px] rounded transition-all ${
                            enableOffset
                              ? 'bg-orange-500 text-white hover:bg-orange-600'
                              : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                          }`}
                          title={`偏移: ${currentOffset}`}
                        >
                          ⇅
                        </button>
                        {showOffsetMenu === config.wallet_id && (
                          <div className="absolute top-full right-0 mt-1 bg-[var(--card-bg)] border border-[var(--border)] rounded shadow-lg p-2 z-50 w-32">
                            <div className="text-[8px] text-[var(--muted)] mb-1">偏移量</div>
                            <input
                              type="number"
                              value={currentOffset}
                              onChange={(e) => updateOffset(config.wallet_id, parseFloat(e.target.value) || 0)}
                              className="w-full text-xs bg-[var(--background)] border border-[var(--border)] rounded px-1 py-0.5"
                              step="1"
                            />
                            <div className="flex gap-1 mt-1">
                              <button
                                onClick={() => updateOffset(config.wallet_id, 0)}
                                className="flex-1 text-[8px] px-1 py-0.5 bg-gray-600 text-white rounded hover:bg-gray-500"
                              >
                                重置
                              </button>
                              <button
                                onClick={() => setShowOffsetMenu(null)}
                                className="flex-1 text-[8px] px-1 py-0.5 bg-[var(--accent)] text-white rounded hover:opacity-80"
                              >
                                关闭
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="text-sm font-bold text-[var(--success)] flex-shrink-0 ml-1">
                      ${wallet.portfolio_total.toFixed(2)}
                    </div>
                  </div>
                  {/* 第二行：USDC和持仓 */}
                  <div className="grid grid-cols-2 gap-1">
                    <div className="bg-[var(--background)] rounded p-1">
                      <div className="text-[8px] text-[var(--muted)] mb-0.5">USDC</div>
                      <div className="text-[11px] font-bold text-[var(--accent)]">${wallet.usdc_balance.toFixed(2)}</div>
                    </div>
                    <div className="bg-[var(--background)] rounded p-1">
                      <div className="text-[8px] text-[var(--muted)] mb-0.5">持仓</div>
                      <div className="text-[11px] font-bold text-[var(--foreground)]">${wallet.positions_value.toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </aside>
      </div>

      {/* 删除确认对话框 */}
      {deleteDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-[var(--card-bg)] border border-[var(--border)] rounded-lg p-6 max-w-md w-full mx-4 shadow-2xl">
            <h3 className="text-lg font-bold mb-4 text-[var(--foreground)]">确认删除数据点</h3>
            <div className="space-y-3 mb-6">
              <div className="flex justify-between text-sm">
                <span className="text-[var(--muted)]">钱包:</span>
                <span className="font-semibold text-[var(--foreground)]">{deleteDialog.walletName}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[var(--muted)]">时间:</span>
                <span className="font-semibold text-[var(--foreground)]">
                  {new Date(deleteDialog.timestamp).toLocaleString('zh-CN')}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[var(--muted)]">数值:</span>
                <span className="font-semibold text-[var(--foreground)]">${deleteDialog.value.toFixed(2)}</span>
              </div>
            </div>
            <div className="bg-yellow-500 bg-opacity-10 border border-yellow-500 rounded p-3 mb-6">
              <p className="text-sm text-yellow-600 dark:text-yellow-400">
                ⚠️ 此操作将永久删除该数据点，无法撤销！
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleDeleteCancel}
                className="flex-1 px-4 py-2 rounded-lg border border-[var(--border)] hover:bg-[var(--background)] transition text-sm"
              >
                取消
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="flex-1 px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 transition text-sm font-semibold"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
