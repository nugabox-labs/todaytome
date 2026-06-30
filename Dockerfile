FROM node:23.6-alpine

WORKDIR /usr/src/todaytome/app

RUN npm install -g pm2

# package.json만 먼저 복사해 npm install 레이어 캐시 — 코드만 바뀌면 이 레이어 재사용
COPY app/package*.json ./
COPY app/prisma ./prisma/
RUN npm install && npx prisma generate

# 나머지 소스 복사 (volume mount 환경에서는 컨테이너 기동 후 덮어씌워짐)
COPY app/ .

EXPOSE 3927

# npm install은 빌드 시 완료됐으므로 CMD에서 생략 — 기동 시간 단축
CMD sh -c "mkdir -p ../data && npx prisma db push && pm2-runtime start app.js --name todaytome-api"
