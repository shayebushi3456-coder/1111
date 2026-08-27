#!/usr/bin/env bash
# 阶段一冒烟：配置中心（被测端点多套）+ 用例集 CRUD。
# 依赖：服务已在 BASE_URL 运行，jq 可选。
set -euo pipefail
BASE_URL=${BASE_URL:-http://localhost:8080}

echo "== 健康检查 =="
curl -s "$BASE_URL/healthz"; echo

echo "== 1. 新增被测端点（默认端点，api_key 会被加密） =="
EP=$(curl -s -X POST "$BASE_URL/api/v1/config/target-endpoints" \
  -H 'Content-Type: application/json' \
  -d '{"name":"prod-gpt-x","base_url":"https://target-llm.example.com/v1","model_name":"gpt-x","api_key":"sk-supersecret1234","is_default":true}')
echo "$EP"
EP_ID=$(echo "$EP" | (jq -r '.id' 2>/dev/null || sed -n 's/.*"id":"\([^"]*\)".*/\1/p'))
echo "endpoint id: $EP_ID"

echo "== 2. 列出端点（api_key 应脱敏为 ****1234） =="
curl -s "$BASE_URL/api/v1/config/target-endpoints"; echo

echo "== 3. 更新端点（不传 api_key，应保留原值） =="
curl -s -X PUT "$BASE_URL/api/v1/config/target-endpoints/$EP_ID" \
  -H 'Content-Type: application/json' \
  -d '{"name":"prod-gpt-x","base_url":"https://target-llm.example.com/v1","model_name":"gpt-x-turbo","is_default":true}'; echo

echo "== 4. 创建用例集（校验点为纯文本数组） =="
CS=$(curl -s -X POST "$BASE_URL/api/v1/case-sets" \
  -H 'Content-Type: application/json' \
  -d @examples/create-case-set.json)
echo "$CS"
CS_ID=$(echo "$CS" | (jq -r '.case_set.id' 2>/dev/null || sed -n 's/.*"id":"\(cs-[^"]*\)".*/\1/p' | head -1))
echo "case-set id: $CS_ID"

echo "== 5. 查询用例集详情（含用例与校验点） =="
curl -s "$BASE_URL/api/v1/case-sets/$CS_ID"; echo

echo "== 6. 列出用例集 =="
curl -s "$BASE_URL/api/v1/case-sets"; echo

echo "== 7. 删除端点与用例集（清理） =="
curl -s -X DELETE "$BASE_URL/api/v1/case-sets/$CS_ID"; echo
curl -s -X DELETE "$BASE_URL/api/v1/config/target-endpoints/$EP_ID"; echo

echo "== 完成 =="
