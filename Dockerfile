# Single image, used for both the dashboard and the agent (different commands).
# node:sqlite is built into Node >= 22.5, so there is no native build step.
FROM node:22-alpine

ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    DB_PATH=/data/studio.db \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app

# deps first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# app
COPY src ./src
COPY README.md ./

# data dir owned by the non-root runtime user; a named volume mounts here at runtime
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8787

# default = all-in-one (dashboard + in-process scheduler).
# docker-compose overrides this per service to split them.
CMD ["node", "src/server.js"]
