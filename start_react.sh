#!/bin/bash

# Portfolio Checker 启动脚本
# 端口: 后端 8405, 前端 3405

BACKEND_PORT=8405
FRONTEND_PORT=3405
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
    echo -e "\n${YELLOW}正在关闭服务...${NC}"
    
    # 关闭后端
    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
        kill "$BACKEND_PID" 2>/dev/null
        echo -e "${GREEN}后端已关闭${NC}"
    fi
    
    # 关闭前端
    if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        kill "$FRONTEND_PID" 2>/dev/null
        echo -e "${GREEN}前端已关闭${NC}"
    fi
    
    exit 0
}

trap cleanup SIGINT SIGTERM

echo -e "${YELLOW}检查是否有该项目的进程在运行...${NC}"

# 检查并关闭占用端口8405的进程（后端）
BACKEND_PIDS=$(lsof -ti :$BACKEND_PORT 2>/dev/null)
if [ -n "$BACKEND_PIDS" ]; then
    echo -e "${YELLOW}发现端口 $BACKEND_PORT 被占用，正在关闭...${NC}"
    echo "$BACKEND_PIDS" | xargs kill -9 2>/dev/null
    sleep 1
fi

# 检查并关闭占用端口3405的进程（前端）
FRONTEND_PIDS=$(lsof -ti :$FRONTEND_PORT 2>/dev/null)
if [ -n "$FRONTEND_PIDS" ]; then
    echo -e "${YELLOW}发现端口 $FRONTEND_PORT 被占用，正在关闭...${NC}"
    echo "$FRONTEND_PIDS" | xargs kill -9 2>/dev/null
    sleep 1
fi

echo -e "${GREEN}端口检查完成${NC}"

# 启动后端
echo -e "${YELLOW}启动后端服务 (端口 $BACKEND_PORT)...${NC}"
cd "$SCRIPT_DIR/portfolio-backend"
cargo run 2>&1 | sed 's/^/[后端] /' &
BACKEND_PID=$!

# 等待后端编译启动
sleep 2

# 启动前端
echo -e "${YELLOW}启动前端服务 (端口 $FRONTEND_PORT)...${NC}"
cd "$SCRIPT_DIR/portfolio-frontend"
npm run dev 2>&1 | sed 's/^/[前端] /' &
FRONTEND_PID=$!

echo -e "${GREEN}服务已启动${NC}"
echo -e "后端: http://localhost:$BACKEND_PORT"
echo -e "前端: http://localhost:$FRONTEND_PORT"
echo -e "${YELLOW}按 Ctrl+C 关闭所有服务${NC}"

# 等待子进程
wait
