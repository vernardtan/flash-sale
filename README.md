# Flash Sale System

A high-throughput flash sale backend (single product, limited stock, one item per user) with a React frontend, fully Dockerized.

**Current status: Phase 3 — persistence & domain foundation.** Business APIs (checkout, transaction, purchase) land in Phase 4. Full architecture documentation is finalized in Phase 10.

## Quick start

Prerequisite: Docker Desktop / Docker Engine with Docker Compose. Nothing else needs to be installed on the host.

```bash
cp .env.example .env
docker compose up --build
```

On startup the backend container automatically:

1. Applies database migrations (`prisma migrate deploy`).
2. Runs the idempotent development seed when `SEED_ON_STARTUP=true` (default in `.env.example`).
3. Starts the API.

- Frontend: http://localhost:5173
- Backend API: http://localhost:3000/api
- Health check: http://localhost:3000/api/health

## Tech stack

| Layer     | Technology                                   |
| --------- | -------------------------------------------- |
| Backend   | NestJS 12, TypeScript (ESM, strict)          |
| Frontend  | React 19, TypeScript, Vite, nginx            |
| Database  | PostgreSQL 17 (source of truth)              |
| ORM       | Prisma 6 (migrations + data access)          |
| Cache     | Redis 7 (rate limiting in Phase 5; never authoritative for inventory/purchases) |
| Testing   | Jest, Supertest, k6 (Phase 8)                |
| Infra     | Docker, Docker Compose                       |

## Data model

```text
Product 1 ──── * FlashSale
   │
   ├── * Checkout ──── 1 Purchase
   │       (request_id UNIQUE)   (user_id UNIQUE, request_id UNIQUE FK)
   └── * Purchase
```

- **products** — catalog + inventory. `total_stock >= 0`, `0 <= remaining_stock <= total_stock` (CHECK constraints). Price/currency with `DECIMAL(12,2)`; `is_enabled` controls whether the product can be sold at all.
- **flash_sales** — sale window per product. CHECK `end_time > start_time`. Sale status (UPCOMING/ACTIVE/ENDED/SOLD_OUT/DISABLED) is **derived**, never persisted.
- **checkouts** — a purchase intent. `request_id` unique (client-generated idempotency handle for Phase 4), `quantity > 0` (generic; the flash-sale rule `quantity = 1` is enforced in the business layer), price/currency **snapshot**, `payment_method` (providers mocked), status `PENDING/COMPLETED/EXPIRED/CANCELLED`, `expires_at`.
- **purchases** — a fulfilled checkout. `UNIQUE(user_id)` is the authoritative one-item-per-user guarantee under concurrency; `UNIQUE(request_id)` means a checkout completes at most once. Full price snapshot.

Design notes:

- **PostgreSQL is authoritative** for inventory, checkouts, and purchases. Redis never decides correctness.
- **Price snapshots**: checkout and purchase copy `unit_price`/`currency` (and `total_amount`) so later product price changes never alter existing orders.
- **No `transactions` table**: the Phase 4 "transaction" is the atomic business operation (valid checkout + eligible user + active sale + available stock → purchase), not an entity.
- All timestamps are `TIMESTAMPTZ` and treated as UTC end to end.

## Database commands

Run from `backend/`. Host-side commands need a `DATABASE_URL` pointing at the published port (the `.env` value points at the `postgres` *service* for in-compose use):

```bash
# Apply migrations to your dev database (compose stack running)
cd backend
set DATABASE_URL=postgresql://flash_sale:flash_sale_dev@localhost:5432/flash_sale   # PowerShell: $env:DATABASE_URL='...'
npm run db:deploy

# Create a new migration after changing prisma/schema.prisma
npm run db:migrate -- --name <change-name>

# Re-run the idempotent seed
npm run db:seed
# …or inside the running stack:
docker compose exec backend npm run db:seed
```

CHECK constraints are hand-written in the initial migration (Prisma schema cannot express them) — do not regenerate that migration from scratch.

## Reset development data

```bash
docker compose down -v    # drops postgres/redis volumes
docker compose up --build # migrations + seed run automatically
```

## Environment variables

See [.env.example](.env.example). Highlights:

| Variable                     | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `DATABASE_URL`               | Prisma connection string (postgres service in compose)         |
| `DATABASE_*`                 | Credentials for the postgres container itself                  |
| `REDIS_HOST` / `REDIS_PORT`  | Redis connection                                               |
| `FLASH_SALE_ENABLED`         | Operational kill switch for the sale                           |
| `CHECKOUT_EXPIRATION_SECONDS`| Lifetime of a PENDING checkout (default 900)                   |
| `SEED_ON_STARTUP`            | Run the dev seed on backend startup (default `true`)           |

Never commit `.env`.

## Testing

Unit tests run anywhere; e2e tests run on the host against the Docker-published PostgreSQL/Redis ports and use a dedicated `flash_sale_test` database (created and migrated automatically by the test harness):

```bash
cd backend
docker compose up -d postgres redis   # dependencies for e2e

npm test            # unit tests
npm run test:e2e    # health + database constraint/seed tests
npm run lint
npm run typecheck
npm run build
```

The e2e suite verifies the schema guarantees that Phase 4 relies on: foreign keys, `UNIQUE(user_id)` / `UNIQUE(request_id)`, stock/quantity/window CHECK constraints, and seed idempotency.
