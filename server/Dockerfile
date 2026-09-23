# Build from the repository root: docker build -f server/Dockerfile .
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev
COPY server/src server/src
COPY tracker tracker
COPY demo-site demo-site
WORKDIR /app/server
USER node
CMD ["node", "src/api.js"]
