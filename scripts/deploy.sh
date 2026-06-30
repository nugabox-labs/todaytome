#!/usr/bin/env bash
# 빠른 배포 스크립트
# - package.json 변경 없으면 이미지 재빌드 없이 컨테이너만 재시작 (수 초)
# - package.json 변경 있으면 이미지 재빌드 (npm install 포함, ~1분)
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[deploy] git pull..."
BEFORE=$(git rev-parse HEAD)
git pull

CHANGED_PKG=$(git diff --name-only "$BEFORE" HEAD -- app/package.json app/package-lock.json app/prisma/schema.prisma | wc -l)

if [ "$CHANGED_PKG" -gt 0 ]; then
  echo "[deploy] package.json / prisma 변경 감지 → 이미지 재빌드"
  docker compose up -d --build
else
  echo "[deploy] 코드만 변경 → 컨테이너 재시작만"
  docker compose restart app
fi

echo "[deploy] 완료"
