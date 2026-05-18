FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY package.json ./
COPY server.js ./
COPY public ./public

EXPOSE 3000

CMD ["npm", "start"]
