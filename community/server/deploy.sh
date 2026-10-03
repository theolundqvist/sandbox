#!/bin/sh
# Ships the community API to the npm box. db.env, r2.env and providers.env live only there and are never copied or overwritten.
set -e
cd "$(dirname "$0")"
rsync -a --chmod=F644 Dockerfile compose.yaml r2.ts retention.ts schema.sql server.ts takedown.ts replay.ts backup.ts npm:/opt/sandbox-api/
ssh npm 'cd /opt/sandbox-api && docker compose up -d --build --remove-orphans && docker compose ps'
