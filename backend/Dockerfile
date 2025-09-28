FROM node:20-slim

# ffmpeg for runtime if you prefer system ffmpeg; we still set ffmpeg-static path
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

USER node
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","server.js"]
