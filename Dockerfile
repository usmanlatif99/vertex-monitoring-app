FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY server/ ./server/
COPY public/ ./public/
COPY db/     ./db/

EXPOSE 3000

CMD ["node", "server/index.js"]
