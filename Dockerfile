FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
COPY package.json ./
COPY src ./src
COPY web ./web
USER node
CMD ["node", "src/server.js"]
