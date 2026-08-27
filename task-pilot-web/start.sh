#!/usr/bin/env bash
# WorkEval 启动脚本：构建生产产物并启动本地服务器托管 dist/。
#
# 与旧版的区别：不再跑 `vite dev`（带 HMR 的开发服务器），而是先执行
# `npm run build` 产出真实的生产构建（dist/），再用 `vite preview` 托管这份
# 构建产物——启动后看到的就是构建后的产物本身，不是开发态热更新服务。
#
# 后端地址配置（构建前设置好，见下方“环境变量”）：
#   - 未设置任何变量时，构建产物默认按相对路径 /api/v1/... 发请求，
#     需要反向代理把 /api 转发到 task-pilot 后端（推荐的生产方式）。
#   - 设置 VITE_API_BASE_URL 后，构建产物会固化请求到该绝对地址，
#     适合前端与后端不同源部署、且后端已开放 CORS 的场景。
#   - TASKPILOT_DEV_PROXY_TARGET 仅影响本脚本内 `vite preview` 自带的
#     开发期代理，不影响构建产物本身；生产环境请使用反代或
#     VITE_API_BASE_URL，不要依赖这个代理。
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 Node.js 18+（https://nodejs.org）后重试。"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖…"
  npm install
fi

if [ -f .env ]; then
  echo "检测到 .env，构建将使用其中配置的 VITE_API_BASE_URL 等变量。"
elif [ -n "$VITE_API_BASE_URL" ]; then
  echo "使用当前 shell 环境变量 VITE_API_BASE_URL=$VITE_API_BASE_URL 进行构建。"
else
  echo "未设置 VITE_API_BASE_URL，构建产物将使用相对路径 /api/v1/...，"
  echo "需要反向代理把 /api 转发到 task-pilot 后端，否则接口请求会失败。"
fi

echo "正在构建生产产物（npm run build）…"
npm run build

echo "启动本地服务器托管构建产物 dist/（默认 http://localhost:4173）…"
npm run preview -- --host
