#!/usr/bin/env bash
set -euo pipefail
BASE_URL=${BASE_URL:-http://localhost:8080}

echo "health check"
curl -s "$BASE_URL/healthz" | jq .

echo "create task"
TASK_ID=$(curl -s -X POST "$BASE_URL/api/v1/tasks" \
  -H 'Content-Type: application/json' \
  -d @examples/create-task.json | tee /tmp/task-pilot-create.json | jq -r '.task.id')

echo "task id: $TASK_ID"
echo "get task"
curl -s "$BASE_URL/api/v1/tasks/$TASK_ID" | jq .

echo "logs summary"
curl -s "$BASE_URL/api/v1/tasks/$TASK_ID/logs" | jq .
