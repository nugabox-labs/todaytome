FROM node:23.6-alpine

WORKDIR /usr/src/todaytome

RUN npm install -g pm2

COPY . .

WORKDIR /usr/src/todaytome/app
RUN npm install && npx prisma generate

EXPOSE 3927

CMD sh -c "npx prisma db push && npm install && pm2-runtime start app.js --name todaytome-api"
