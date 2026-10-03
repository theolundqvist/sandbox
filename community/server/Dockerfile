FROM oven/bun:1.3-alpine
RUN apk add --no-cache postgresql17-client zstd
WORKDIR /app
COPY r2.ts retention.ts schema.sql server.ts takedown.ts replay.ts backup.ts ./
USER bun
