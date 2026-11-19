FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /app/auth_info /app/.tmp /app/logs

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
