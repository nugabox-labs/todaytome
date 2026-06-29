# todaytome-api

**오늘 나에게 / Today To Me** iOS 앱용 Node.js REST API 서버입니다.

- 루트 `/` — 앱 홍보용 랜딩 페이지
- `/health` — 서버 상태 확인
- `/api/*` — 앱·단축어·외부 연동 API

## 기술 스택

- Node.js, Express, Prisma, SQLite (앱 컨테이너 내장, 별도 DB 컨테이너 없음)
- Docker Compose (운영/개발 구분 없이 단일 구성)
- 포트: **3927**

## 로컬 실행

```bash
cp app/.env.example app/.env
docker compose up -d
```

- 홍보 페이지: http://localhost:3927/
- Health: http://localhost:3927/health

## API

| Method | Path | 설명 |
|---|---|---|
| GET | `/health` | 서버 상태 |
| POST | `/api/add-user` | 사용자 등록 |
| GET | `/api/user/:userId` | 사용자 조회 |
| POST | `/api/add-record` | 말씀 등록 |
| GET | `/api/today` | 오늘의 말씀 조회 |
| GET | `/api/records` | 말씀 기록 조회 |
| POST | `/api/register-device` | 기기 등록 |
| POST | `/api/live-activity-token` | Live Activity 토큰 저장 |
| GET | `/api/shortcut/sample` | 단축어 샘플 |

`userId`는 레거시 8자리(`a9x2k7pq`)와 iCloud 형식(`_abc123def456`) 모두 허용합니다.

## 배포

`main` 브랜치 push 시 self-hosted runner(`nugacloud`)가 `/volume1/Develop/Sites/todaytome`에서 `docker compose up -d`로 배포합니다.

GitHub Secret: `TELEGRAM_BOT_TOKEN` (배포 알림, 선택)
