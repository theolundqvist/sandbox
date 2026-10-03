FROM oven/bun:1.4.2-alpine
RUN apk add --no-cache postgresql17-client zstd
WORKDIR /app
COPY r2.ts retention.ts schema.sql server.ts admin.ts mods.ts takedown.ts replay.ts backup.ts ./
USER bun
