# Cloudflare Tunnel + 本机密码网关部署文档

## 1. 目标

本方案要解决的问题是：

- 你人在外面时，可以直接在任意浏览器里输入一个网址访问这个项目。
- 访问前先输入一个简单密码。
- 不需要开放家里路由器的公网端口。
- 尽量少改动当前项目代码。
- 尽量避免别人直接碰到你的后端接口。

## 2. 最终结构

推荐的结构如下：

```text
外部浏览器
  -> HTTPS
Cloudflare
  -> Cloudflare Tunnel
cloudflared（运行在你的 Mac mini 上）
  -> http://127.0.0.1:8080
Caddy（本机密码网关）
  -> /api/*      转发到 http://127.0.0.1:8405
  -> 其他请求    转发到 http://127.0.0.1:3405
Next.js 前端
Rust 后端
```

含义很简单：

- Cloudflare Tunnel 负责给你一个可公开访问的网址。
- Caddy 负责在本机先拦一道密码。
- 前端和后端都放在这道密码后面。
- 外部访问者永远不应该直接碰到 `3405` 或 `8405`。

## 3. 为什么这个方案比“直接开公网端口”更安全

因为你不是把 `3405` 或 `8405` 直接映射到互联网。

你家里的 Mac mini 会主动连接到 Cloudflare，建立一条长期在线的隧道。外部访问者访问的是 Cloudflare 分配给你的域名，请求先到 Cloudflare，再通过隧道转到你本机的 Caddy，然后再由 Caddy 转给前端和后端。

这意味着：

- 你家路由器不用开放 `3405` 或 `8405`
- 你的公网 IP 不需要直接暴露服务
- 攻击者不能直接扫到你机器上的应用端口

## 4. HTTPS 是怎么实现的

这个方案里的 HTTPS 主要发生在：

- 浏览器 <-> Cloudflare

也就是说，外部浏览器访问的是：

```text
https://your-domain.example.com
```

这段连接由 Cloudflare 提供 HTTPS 证书和 TLS 终止。

然后：

- Cloudflare <-> cloudflared

这一段由 Cloudflare Tunnel 自己维护。

最后：

- cloudflared <-> Caddy
- Caddy <-> Next.js / Rust

这两段通常跑在同一台 Mac mini 的 `127.0.0.1` 回环地址上。因为它们只在你本机内部流转，不经过公网，所以这里使用本机 HTTP 是可接受的。

简化理解就是：

- 对外是 HTTPS
- 对内是本机 localhost 通信

## 5. 当前项目里已经完成的代码改动

为了支持“统一入口 + 同源请求”，项目已经做了两处最小改动：

1. 前端改成同源请求 API
2. Next.js 增加 `/api` 到后端的本地转发

相关文件：

- [portfolio-frontend/src/app/page.tsx](/Users/yedelai/polymarket/portfolio_checker/portfolio-frontend/src/app/page.tsx)
- [portfolio-frontend/next.config.ts](/Users/yedelai/polymarket/portfolio_checker/portfolio-frontend/next.config.ts)

## 8. 需要安装的软件

在 Mac mini 上安装：

- `cloudflared`
- `caddy`

如果你用 Homebrew，安装命令通常是：

```bash
brew install cloudflared caddy
```

## 9. 域名准备

你需要一个自己的域名，或者至少一个你可以在 Cloudflare 上管理的域名。

例如：

```text
portfolio.example.com
```

后续外部访问时，你输入的就是这个域名。

## 10. Caddy 作为本机密码网关

### 10.1 原理

Caddy 放在本机 `127.0.0.1:8080`，负责两件事：

- 先拦截访问并弹出用户名/密码框
- 验证通过后再把请求转给前端和后端

### 10.2 为什么要把密码网关放在这里

因为你要保护的不是只有前端页面，还包括：

- `/api/wallets`
- `/api/portfolio/cached`
- `/api/portfolio/history`
- `/api/portfolio/refresh`
- `/api/portfolio/snapshot`

所以必须把整站都放在密码后面，而不是只保护首页。

### 10.3 生成密码哈希

不要把明文密码直接写到配置文件里。先生成哈希：

```bash
caddy hash-password --plaintext '你的密码'
```

它会输出一串 bcrypt 哈希，后面放进 Caddy 配置里。

### 10.4 Caddyfile 示例

下面是一份最小可用示例：

```caddy
:8080 {
    basicauth {
        admin $2a$14$REPLACE_WITH_YOUR_BCRYPT_HASH
    }

    reverse_proxy /api/* 127.0.0.1:8405
    reverse_proxy 127.0.0.1:3405
}
```

说明：

- `:8080` 表示 Caddy 在本机 8080 端口监听
- `basicauth` 表示先弹出浏览器密码框
- `/api/*` 转给后端
- 其他请求转给前端

这里的密码验证是浏览器原生的 Basic Auth 弹窗。体验上很接近：

- 打开网址
- 输入用户名和密码
- 立刻进入页面

如果你只想要“输入一个密码”，理论上也可以固定用户名，比如一直叫 `admin`。

## 11. cloudflared 作为外网入口

### 11.1 原理

`cloudflared` 是运行在你 Mac mini 上的一个程序，它会主动连到 Cloudflare。

然后 Cloudflare 把公网请求通过隧道送到：

```text
http://127.0.0.1:8080
```

也就是你本机上的 Caddy。

### 11.2 配置目标

Tunnel 的目标不是前端 `3405`，也不是后端 `8405`，而是：

```text
http://127.0.0.1:8080
```

因为 `8080` 这个入口已经包含了：

- 密码验证
- 前端代理
- 后端代理

## 12. 推荐的实际流量路径

完整请求路径如下：

1. 你在外面打开 `https://portfolio.example.com`
2. 请求先到 Cloudflare
3. Cloudflare 通过 Tunnel 把请求送到你家里 Mac mini 的 `cloudflared`
4. `cloudflared` 把请求交给本机 `127.0.0.1:8080`
5. Caddy 弹出用户名/密码框
6. 密码正确后：
   - 页面请求转到前端 `127.0.0.1:3405`
   - API 请求转到后端 `127.0.0.1:8405`
7. 页面正常显示

## 13. 一个可执行的部署顺序

建议你按这个顺序做：

3. 安装 Caddy
4. 配好 `Caddyfile`
5. 本机先访问 `http://127.0.0.1:8080`，确认密码框能弹出，页面能打开
6. 安装并登录 `cloudflared`
7. 创建 Tunnel
8. 把域名指向这个 Tunnel
9. 把 Tunnel 的目标设置为 `http://127.0.0.1:8080`
10. 在外部网络用浏览器访问域名，确认能看到密码框并进入页面

## 14. Cloudflare Tunnel 的配置思路

实际操作时，你需要完成三件事：

1. 登录 Cloudflare 账号
2. 创建一个 Tunnel
3. 让某个域名指向这个 Tunnel

Tunnel 的后端目标填：

```text
http://127.0.0.1:8080
```

只要这个目标能在 Mac mini 本机打开，Tunnel 就能把公网流量带进来。


## 18. 你后续最可能真正需要我帮你做的事

如果你继续按这个方案推进，我建议下一步让我直接帮你做这三件事：

3. 在仓库里补一个可直接使用的 `Caddyfile`

这样你后面只需要：

- 安装 `caddy`
- 安装 `cloudflared`
- 按文档把 Tunnel 指过去

## 19. 简短结论

这套方案的核心是：

- 用 Cloudflare Tunnel 提供“一个外网网址”
- 用本机 Caddy 提供“一个简单密码门”
- 用同源代理把前端和后端都放在这道门后面
- 用 Cloudflare 提供外部 HTTPS

对于“只有你一个人用、人在外面偶尔打开浏览器看看”的场景，这已经是相对省事且安全边界比较清楚的一套方案。
