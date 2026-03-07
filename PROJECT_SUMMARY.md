# Portfolio Checker 项目总结

## 1. 项目概述

`portfolio_checker` 是一个用于监控和查看 Polymarket 多钱包资产情况的本地化项目，主要面向开发者或维护者，用于快速了解多个代理钱包的资产总额、USDC 余额、持仓价值以及历史变化趋势。

项目整体采用前后端分离架构：

- 后端负责读取钱包配置、抓取链上和 Polymarket 数据、缓存与持久化快照，并提供 HTTP API。
- 前端负责展示资产总览、历史曲线和钱包维度的数据交互。
- 仓库内还包含一个独立的 Rust Polymarket 客户端库 `rs-clob-client`，可作为底层能力或扩展参考。

## 2. 主要功能

### 2.1 钱包资产聚合

后端会从环境变量中读取多个钱包的代理地址配置，并逐个拉取：

- 链上 Polygon 网络中的 USDC 余额
- Polymarket Data API 返回的持仓价值
- 每个钱包的资产总额（`USDC + Positions`）

### 2.2 实时刷新与缓存读取

系统同时支持两种读取方式：

- 快速读取当前缓存或数据库中的最新快照
- 主动触发刷新，重新从外部数据源抓取最新资产数据

前端初始化时优先读取缓存，降低页面打开时延；手动刷新或定时刷新时再调用后端实时拉取数据。

### 2.3 历史快照与趋势展示

后端会在每次刷新后将资产快照写入 SQLite 数据库，并提供历史查询接口。前端基于这些历史数据展示：

- 各钱包资产变化曲线
- 总资产、总 USDC、总持仓价值趋势
- 指定时间范围内的历史表现

### 2.4 钱包可视化定制

前端提供较强的本地交互能力，包括：

- 钱包显示/隐藏
- 钱包名称自定义
- 钱包颜色自定义
- 单钱包曲线偏移量设置
- 时区切换
- 图表缩放与区间查看

这些个性化设置保存在浏览器本地 `localStorage` 中，不依赖后端存储。

### 2.5 历史数据修正

前端支持对历史图表中的某个快照点发起删除操作，后端会根据钱包地址和时间戳删除对应数据库记录，便于手动清理异常数据点。

## 3. 项目主要结构

仓库的核心结构如下：

```text
portfolio_checker/
├── portfolio-backend/     # Rust 后端服务
├── portfolio-frontend/    # Next.js 前端页面
├── rs-clob-client/        # 独立 Rust Polymarket 客户端库
├── start_react.sh         # 前后端一键启动脚本
├── migrate_to_sqlite.sh   # MySQL 到 SQLite 的迁移脚本
└── .env                   # 本地运行配置（钱包地址、RPC Key 等）
```

### 3.1 `portfolio-backend`

后端主服务目录，负责数据抓取、缓存、存储和 API 提供。

核心文件职责：

- `src/main.rs`
  - 应用入口
  - 注册路由
  - 初始化数据库连接
  - 持有全局状态（钱包配置、内存缓存、数据库连接池）
- `src/config.rs`
  - 从 `.env` 读取钱包配置
  - 组装钱包 ID、名称、代理地址
- `src/portfolio.rs`
  - 拉取单钱包组合数据
  - 调用 Polygon RPC 获取 USDC 余额
  - 调用 Polymarket Data API 获取持仓价值
  - 汇总为统一的资产结构
- `src/db.rs`
  - 管理 SQLite 连接池
  - 自动建表建索引
  - 提供快照保存、历史查询、最新快照读取、删除等数据库方法
- `src/error.rs`
  - 定义项目统一错误类型

### 3.2 `portfolio-frontend`

前端展示层，基于 Next.js App Router 构建单页仪表盘。

核心文件职责：

- `src/app/page.tsx`
  - 主要页面逻辑与交互
  - 负责调用后端 API
  - 渲染资产卡片、钱包列表、图表和删除弹窗
- `src/app/layout.tsx`
  - 页面根布局和元信息
- `src/app/providers.tsx`
  - 注入主题提供器
- `src/app/globals.css`
  - 全局样式定义

### 3.3 `rs-clob-client`

该目录是一个独立的 Rust 客户端库，用于与 Polymarket CLOB 服务交互，包含认证、订单构建、类型定义、示例和测试。它不是当前资产看板页面的直接展示层，但属于仓库的重要基础能力和扩展资源。

### 3.4 脚本与辅助文件

- `start_react.sh`
  - 一键启动前后端服务
  - 默认后端端口 `8405`
  - 默认前端端口 `3405`
- `migrate_to_sqlite.sh`
  - 将历史数据从 MySQL 迁移到 SQLite
- `portfolio-backend/*.sql`
  - 用于修正缺失数据或异常数据的 SQL 脚本

## 4. 技术栈

### 4.1 后端技术栈

- Rust 2024 Edition
- Axum
- Tokio
- SQLx
- SQLite
- Reqwest
- Alloy
- Serde / Serde JSON
- Tracing / Tracing Subscriber
- Dotenvy

后端的核心特点是：

- 使用异步并发方式抓取多个钱包数据
- 通过内存缓存和 SQLite 快照提升读取效率
- 对 RPC 调用失败设计了兜底机制

### 4.2 前端技术栈

- Next.js 16
- React 19
- TypeScript
- Recharts
- next-themes
- Tailwind CSS 4

前端的核心特点是：

- 基于单页仪表盘展示数据
- 强依赖图表交互和本地状态管理
- 使用浏览器本地存储保存用户个性化配置

### 4.3 数据与运行环境

- 数据库：SQLite
- 配置来源：根目录 `.env`
- 外部依赖：
  - Polygon RPC
  - Polymarket Data API

## 5. 功能模块划分

### 5.1 配置加载模块

后端启动时从 `.env` 中读取多个 `WALLET_<N>_PROXY_ADDRESS` 配置，并为钱包分配默认名称。该模块决定系统会监控哪些钱包。

### 5.2 资产采集模块

该模块位于后端 `portfolio.rs`，负责：

- 请求 Polygon RPC 查询 USDC 合约余额
- 请求 Polymarket Data API 查询钱包持仓价值
- 合并为统一的 `PortfolioData`

同时支持多个 RPC 端点轮询，减少单个 RPC 不稳定带来的失败概率。

### 5.3 缓存与持久化模块

后端使用两级数据保存方式：

- 内存缓存：保存当前最新数据，便于快速返回
- SQLite 快照：保存历史记录，便于趋势分析和回溯

当实时请求失败时，后端还会尝试读取最近一条 USDC 非零历史记录作为兜底数据。

### 5.4 API 接口模块

后端通过 Axum 暴露以下主要接口：

- `GET /api/health`
  - 健康检查
- `GET /api/wallets`
  - 获取钱包配置列表
- `GET /api/portfolio/refresh`
  - 刷新并抓取最新资产数据
- `GET /api/portfolio/cached`
  - 获取缓存或数据库中的最新快照
- `GET /api/portfolio/history?hours=<n>`
  - 获取指定时间范围内的历史数据
- `DELETE /api/portfolio/snapshot`
  - 删除指定钱包指定时间点的快照

### 5.5 前端展示与交互模块

前端页面承担以下职责：

- 展示总资产、总 USDC、总持仓
- 展示钱包列表和每个钱包的当前状态
- 拉取历史数据并渲染多条折线/面积图
- 允许用户设置筛选范围、时区、图表偏移与颜色
- 支持点击图表数据点后删除异常记录

## 6. 核心数据流

项目的数据流可以概括为：

1. 后端启动后读取 `.env` 中的钱包配置。
2. 前端调用 `/api/wallets` 与 `/api/portfolio/cached` 获取初始化展示数据。
3. 当触发刷新时，后端并发请求链上 USDC 和 Polymarket 持仓价值。
4. 后端计算组合总额，将结果写入内存缓存与 SQLite 快照表。
5. 前端调用 `/api/portfolio/history` 获取历史序列并绘制图表。
6. 用户的图表偏好与钱包展示设置保存在本地浏览器中。

## 7. 运行方式概览

### 7.1 本地端口

- 后端：`http://localhost:8405`
- 前端：`http://localhost:3405`

### 7.2 启动方式

项目提供 `start_react.sh` 脚本用于一键启动前后端。脚本会先检查端口占用，再分别启动：

- Rust 后端服务
- Next.js 前端开发服务

### 7.3 数据文件

SQLite 数据库文件位于：

- `portfolio-backend/portfolio_checker.db`

## 8. 项目特点与维护重点

这个项目的特点是结构直接、目标明确，适合用作个人或小团队的多钱包资产监控工具。维护时需要重点关注以下几个方面：

- 外部 RPC 和 Polymarket API 的稳定性
- 钱包配置与环境变量管理
- 历史快照数据量增长后的查询性能
- 前端页面中较多的交互状态和图表逻辑复杂度
- 数据异常时的兜底策略是否足够可靠

## 9. 总结

从整体上看，`portfolio_checker` 是一个围绕 Polymarket 多钱包资产追踪构建的全栈项目，具备实时查询、历史记录、可视化展示和基础数据修正能力。其核心价值在于把分散的钱包资产状态聚合成一个可持续观察和分析的本地仪表盘，方便开发者或操盘者进行日常监控与回溯分析。
