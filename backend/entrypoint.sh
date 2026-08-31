#!/bin/sh
set -e

# Apply pending Prisma migrations. This must succeed before the app starts
# because the code expects the schema to be present.
./node_modules/.bin/prisma migrate deploy

# Seed is a development convenience only. A seed failure is logged but does
# not block startup because it is idempotent and can be retried manually.
if [ "$SEED_ON_STARTUP" = "true" ]; then
  ./node_modules/.bin/tsx prisma/seed.ts || echo "Seed skipped or failed (non-fatal)"
fi

exec node dist/main.js
