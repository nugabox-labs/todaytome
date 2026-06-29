#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:3927}"
PASS=0
FAIL=0

check() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "✅ $name"
    PASS=$((PASS + 1))
  else
    echo "❌ $name (expected HTTP $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

check_json() {
  local name="$1"
  local body="$2"
  local pattern="$3"
  if echo "$body" | grep -q "$pattern"; then
    echo "✅ $name"
    PASS=$((PASS + 1))
  else
    echo "❌ $name (pattern '$pattern' not found)"
    echo "   body: $body"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== todaytome API test @ $BASE_URL ==="
echo

# 1. Landing page
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/")
check "GET / (landing)" "200" "$code"

code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/images/icon_todaytome.png")
check "GET /images/icon_todaytome.png" "200" "$code"

# 2. Health
body=$(curl -s "$BASE_URL/health")
check_json "GET /health" "$body" '"ok":true'
check_json "GET /health service" "$body" 'todaytome-api'

# 3. Shortcut sample
body=$(curl -s "$BASE_URL/api/shortcut/sample")
check_json "GET /api/shortcut/sample" "$body" '"ok":true'

# 4. Add user (legacy 8-char)
body=$(curl -s -X POST "$BASE_URL/api/add-user" \
  -H "Content-Type: application/json" \
  -d '{"userId":"a9x2k7pq","platform":"ios","deviceName":"iPhone 16 Pro","icloudEnabled":true}')
check_json "POST /api/add-user (legacy)" "$body" '"userId":"a9x2k7pq"'

# 5. Add user (iCloud format)
body=$(curl -s -X POST "$BASE_URL/api/add-user" \
  -H "Content-Type: application/json" \
  -d '{"userId":"_abc123def456","platform":"ios","icloudEnabled":true}')
check_json "POST /api/add-user (iCloud)" "$body" '"userId":"_abc123def456"'

# 6. Invalid userId
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/add-user" \
  -H "Content-Type: application/json" \
  -d '{"userId":"INVALID"}')
check "POST /api/add-user invalid userId" "400" "$code"

# 7. Get user
body=$(curl -s "$BASE_URL/api/user/a9x2k7pq")
check_json "GET /api/user/:userId" "$body" '"ok":true'

# 8. Get user not found
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/user/zzzzzzzz")
check "GET /api/user not found" "404" "$code"

# 9. Add record
body=$(curl -s -X POST "$BASE_URL/api/add-record" \
  -H "Content-Type: application/json" \
  -d '{"userId":"a9x2k7pq","subject":"시 1:1","bible":"복 있는 자는 악인의 꾀를 좇지 아니하며","date":"2026-06-29","source":"manual"}')
check_json "POST /api/add-record" "$body" '"ok":true'
check_json "POST /api/add-record subject" "$body" '시 1:1'

# 10. Add record for iCloud user
body=$(curl -s -X POST "$BASE_URL/api/add-record" \
  -H "Content-Type: application/json" \
  -d '{"userId":"_abc123def456","subject":"시편 23:1","bible":"여호와는 나의 목자시니","source":"shortcut"}')
check_json "POST /api/add-record (iCloud user)" "$body" '"ok":true'

# 11. Today
body=$(curl -s "$BASE_URL/api/today?userId=a9x2k7pq")
check_json "GET /api/today" "$body" '"ok":true'

# 12. Records
body=$(curl -s "$BASE_URL/api/records?userId=a9x2k7pq&limit=10&offset=0")
check_json "GET /api/records" "$body" '"records"'
check_json "GET /api/records paging" "$body" '"count"'

# 13. Register device
body=$(curl -s -X POST "$BASE_URL/api/register-device" \
  -H "Content-Type: application/json" \
  -d '{"userId":"a9x2k7pq","deviceId":"ios-device-uuid-test","platform":"ios","deviceName":"iPhone 16 Pro","apnsToken":"test_token"}')
check_json "POST /api/register-device" "$body" '"registered":true'

# 14. Live activity token
body=$(curl -s -X POST "$BASE_URL/api/live-activity-token" \
  -H "Content-Type: application/json" \
  -d '{"userId":"a9x2k7pq","deviceId":"ios-device-uuid-test","pushToStartToken":"pts_token","activityPushToken":"ap_token"}')
check_json "POST /api/live-activity-token" "$body" '"saved":true'

# 15. Live activity token - device not found
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/live-activity-token" \
  -H "Content-Type: application/json" \
  -d '{"userId":"a9x2k7pq","deviceId":"unknown-device","pushToStartToken":"x"}')
check "POST /api/live-activity-token device not found" "404" "$code"

echo
echo "=== Result: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
