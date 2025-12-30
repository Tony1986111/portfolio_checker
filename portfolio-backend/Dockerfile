FROM rust:1.88-slim AS builder

WORKDIR /app

# 安装构建依赖
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY Cargo.toml Cargo.lock ./

# 创建虚拟 src 来缓存依赖
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release || true
RUN rm -rf src

# 复制实际源码
COPY src ./src

# 构建
RUN cargo build --release

# 运行时镜像
FROM debian:bookworm-slim

WORKDIR /app

# 安装运行时依赖
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*

# 复制二进制文件
COPY --from=builder /app/target/release/portfolio_backend /app/portfolio_backend

# 暴露端口
EXPOSE 8405

# 启动命令
CMD ["./portfolio_backend"]
