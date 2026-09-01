# Flash Sale System

A high-throughput flash sale backend with a React frontend, fully Dockerized. The flash-sale product is limited stock and one per user; regular products are also supported and can be repurchased.

**Current status: Phase 4 â€” business APIs & purchase flow.** The full flash-sale flow (browse â†’ checkout â†’ transaction â†’ purchase) is implemented with PostgreSQL-enforced concurrency guarantees. Stress testing with k6 lands in Phase 5+.

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

## Architecture

```text
                         React
                           â”‚
                           â–¼
                     NestJS API
                           â”‚
              â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
              â”‚                          â”‚
              â–¼                          â–¼
            Redis                    PostgreSQL
        Rate Limiting               Source of Truth
        (fail-open)                      â”‚
                    â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                    â”‚                    â”‚                 â”‚
                    â–¼                    â–¼                 â–¼
                 Product              Checkout          Purchase
                    â”‚                    â”‚
                    â–¼                    â–¼
               Flash Sale          State Machine
                                   PENDING
                                      â†“
                                  PROCESSING
                                   â†™       â†˜
                              COMPLETED    FAILED
```

- **PostgreSQL is the source of truth** for products, inventory, flash sales, checkouts, and purchases. All correctness invariants (no overselling, one flash-sale item per user, single-use requestId) are enforced by the database.
- **Redis is supporting infrastructure only**: fixed-window rate limiting on the write endpoints. If Redis is down the limiter fails open â€” protection degrades, correctness does not.

## API

All endpoints are prefixed with `/api`. Errors share a consistent shape:

```json
{ "code": "SALE_ENDED", "message": "The flash sale has ended." }
```

| Code | HTTP | Meaning |
| ---- | ---- | ------- |
| `VALIDATION_FAILED` | 400 | Malformed payload (types, formats, unknown fields) |
| `INVALID_QUANTITY` | 400 | Quantity is invalid for the product type (flash-sale = exactly 1, regular = any positive quantity) |
| `INVALID_PAYMENT_METHOD` | 400 | Unsupported payment method |
| `REQUEST_NOT_AUTHORIZED` | 403 | requestId belongs to a different user |
| `CHECKOUT_NOT_FOUND` / `PRODUCT_NOT_FOUND` / `PURCHASE_NOT_FOUND` | 404 | Entity does not exist |
| `SALE_DISABLED` / `SALE_UPCOMING` / `SALE_ENDED` / `SOLD_OUT` / `PRODUCT_DISABLED` / `ALREADY_PURCHASED` | 409 | Sale or eligibility state conflict |
| `TRANSACTION_PROCESSING` / `REQUEST_ALREADY_PROCESSED` | 409 | requestId in flight or already spent |
| `CHECKOUT_EXPIRED` | 410 | Checkout passed its expiry |
| `RATE_LIMITED` | 429 | Too many requests |

### `GET /api/sale/status`

Dynamically derived sale status (never persisted):

```json
{ "status": "ACTIVE", "productId": "â€¦", "startTime": "â€¦", "endTime": "â€¦", "remainingStock": 73 }
```

Derivation priority (first match wins): `FLASH_SALE_ENABLED=false` â†’ `DISABLED`; product missing/disabled or no sale scheduled â†’ `DISABLED`; `now < startTime` â†’ `UPCOMING`; `now >= endTime` â†’ `ENDED`; `remainingStock <= 0` â†’ `SOLD_OUT`; otherwise `ACTIVE`. All comparisons are UTC.

### `GET /api/products`

Returns products with price/currency, stock, flash-sale window, and `buyNowAvailable`. Optional `?userId=` (development-only identity) adds per-user `eligibility` (`ALREADY_PURCHASED` detection).

### `GET /api/payment-methods`

Mocked providers: `GCASH`, `MAYA`, `CARD`. No real payment integration.

### `POST /api/checkouts`

```json
{ "userId": "user-123", "productId": "â€¦", "quantity": 1, "paymentMethod": "GCASH" }
```

Validates product/enabled/flag/sale-window/stock/eligibility/payment method and enforces the quantity rule for the product type: flash-sale products require `quantity = 1`; regular products require `quantity > 0`. The **backend generates `requestId`** (`crypto.randomUUID()`); client-supplied ids are not accepted. Price and currency are snapshotted from the product; `expiresAt = now + CHECKOUT_EXPIRATION_SECONDS`. **Creating a checkout never decrements or reserves stock.**

```json
{ "requestId": "â€¦", "checkoutId": "â€¦", "status": "PENDING", "productId": "â€¦", "quantity": 1, "unitPrice": "1999.00", "currency": "PHP", "expiresAt": "â€¦" }
```

### `POST /api/transactions`

```json
{ "requestId": "â€¦", "userId": "user-123" }
```

The final purchase operation, executed as **one PostgreSQL transaction**:

```text
BEGIN
  â”œâ”€ Load checkout by requestId     â†’ CHECKOUT_NOT_FOUND
  â”œâ”€ Verify ownership               â†’ REQUEST_NOT_AUTHORIZED (no info leak)
  â”œâ”€ Atomic claim: UPDATE checkouts SET status='PROCESSING'
  â”‚    WHERE request_id=$1 AND status='PENDING' RETURNING id
  â”‚    (0 rows â†’ re-read â†’ TRANSACTION_PROCESSING /
  â”‚     REQUEST_ALREADY_PROCESSED / CHECKOUT_EXPIRED)
  â”œâ”€ Revalidate: flag, product enabled, sale window, expiry,
  â”‚    quantity (flash-sale = 1, regular > 0), user not already purchased
  â”‚    (flash-sale only)
  â”œâ”€ Atomic decrement: UPDATE products SET remaining_stock = remaining_stock - $qty
  â”‚    WHERE id=$1 AND remaining_stock >= $qty RETURNING id   (0 rows â†’ SOLD_OUT)
  â”œâ”€ INSERT purchase from the checkout price snapshot with `is_flash_sale`
  â”‚    (partial unique index on `user_id WHERE is_flash_sale = true`
  â”‚     violation â†’ ROLLBACK â†’ ALREADY_PURCHASED)
  â””â”€ Checkout â†’ COMPLETED
COMMIT
```

Deterministic failures (sold out, already purchased, sale no longer valid) mark the checkout `FAILED`/`EXPIRED` and **commit** â€” the requestId is permanently spent. Unexpected errors **roll back**, returning the checkout to `PENDING` so it can never get stuck in `PROCESSING` and stock is never leaked.

```json
{ "purchaseId": "â€¦", "requestId": "â€¦", "status": "COMPLETED", "quantity": 1, "unitPrice": "1999.00", "totalAmount": "1999.00", "currency": "PHP", "paymentMethod": "GCASH", "createdAt": "â€¦" }
```

### `GET /api/purchases/:userId`

Returns the user's purchase or 404. (userId is explicit for this assessment; production would restrict callers to their own data via authentication.)

### Concurrency guarantees

| Threat | Defense |
| ------ | ------- |
| Overselling | Atomic conditional `UPDATE â€¦ WHERE remaining_stock > 0` â€” never read-then-write |
| Duplicate flash-sale purchase per user | Partial unique index `purchases_unique_user_flashsale ON purchases(user_id) WHERE is_flash_sale = true`; violation rolls back the whole transaction, restoring stock. Regular products are not constrained. |
| requestId reuse / double-submit | Atomic `PENDING â†’ PROCESSING` claim (row lock serializes concurrent claims); `COMPLETED`/`FAILED` are terminal |
| Cross-user requestId theft | Ownership check before any state change |
| Request floods | Redis fixed-window rate limit on `POST /checkouts` and `POST /transactions` (per user/IP, fail-open) |

Verified by the e2e concurrency suite: 50 concurrent users against stock 10 â†’ exactly 10 purchases, stock 0; same-user and same-requestId bursts â†’ exactly 1 purchase each.

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
Product 1 â”€â”€â”€â”€ * FlashSale
   â”‚
   â”œâ”€â”€ * Checkout â”€â”€â”€â”€ 1 Purchase
   â”‚       (request_id UNIQUE)   (user_id UNIQUE, request_id UNIQUE FK)
   â””â”€â”€ * Purchase
```

- **products** â€” catalog + inventory. `total_stock >= 0`, `0 <= remaining_stock <= total_stock` (CHECK constraints). Price/currency with `DECIMAL(12,2)`; `is_enabled` controls whether the product can be sold at all.
- **flash_sales** â€” sale window per product. CHECK `end_time > start_time`. Sale status (UPCOMING/ACTIVE/ENDED/SOLD_OUT/DISABLED) is **derived**, never persisted.
- **checkouts** â€” a purchase intent. `request_id` is a server-generated unique idempotency handle created during checkout; the client receives it and includes it in the transaction request. `quantity > 0` (generic; the flash-sale rule `quantity = 1` is enforced in the business layer), price/currency **snapshot**, `payment_method` (providers mocked), status `PENDING/PROCESSING/COMPLETED/EXPIRED/CANCELLED/FAILED`, `expires_at`.
- **purchases** â€” a fulfilled checkout. `UNIQUE(user_id)` is the authoritative one-item-per-user guarantee under concurrency; `UNIQUE(request_id)` means a checkout completes at most once. Full price snapshot.

Design notes:

- **PostgreSQL is authoritative** for inventory, checkouts, and purchases. Redis never decides correctness.
- **Price snapshots**: checkout and purchase copy `unit_price`/`currency` (and `total_amount`) so later product price changes never alter existing orders.
- **No `transactions` table**: the Phase 4 "transaction" is the atomic business operation (valid checkout + eligible user + active sale + available stock â†’ purchase), not an entity.
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
# â€¦or inside the running stack:
docker compose exec backend npm run db:seed
```

CHECK constraints are hand-written in the initial migration (Prisma schema cannot express them) â€” do not regenerate that migration from scratch.

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
| `RATE_LIMIT_WINDOW_SECONDS`  | Rate-limit window (default 60)                                 |
| `RATE_LIMIT_CHECKOUT_MAX`    | Max checkout attempts per user/window (default 10)             |
| `RATE_LIMIT_TRANSACTION_MAX` | Max transaction attempts per user/window (default 20)          |
| `SEED_ON_STARTUP`            | Run the dev seed on backend startup (default `true`)           |

Never commit `.env`.

## Testing

Unit tests run anywhere; e2e tests run on the host against the Docker-published PostgreSQL/Redis ports and use a dedicated `flash_sale_test` database (created and migrated automatically by the test harness):

```bash
cd backend
docker compose up -d postgres redis   # dependencies for e2e

npm test            # unit tests (status derivation, checkout validation, transaction state machine)
npm run test:e2e    # health + schema + full API flow + concurrency proofs
npm run lint
npm run typecheck
npm run build
```

The e2e suite covers:

- **Schema guarantees**: foreign keys, `UNIQUE(user_id)` / `UNIQUE(request_id)`, stock/quantity/window CHECK constraints, seed idempotency.
- **API behavior**: all six business endpoints â€” sale states, checkout validation, price snapshots, expiration, ownership, requestId reuse, error contract.
- **Concurrency proofs** (`test/concurrency.e2e-spec.ts`): 50 concurrent users against stock 10 (exactly 10 purchases, stock 0, no oversell); same-user concurrent burst (exactly 1 purchase, no stock leak, nothing stuck in `PROCESSING`); same-requestId concurrent burst (exactly 1 success, rest `TRANSACTION_PROCESSING`/`REQUEST_ALREADY_PROCESSED`).

## Security notes

- DTO validation (`class-validator` + global `ValidationPipe`, unknown fields stripped).
- Price, totals, stock, sale status, and eligibility are computed server-side only â€” clients never supply them.
- requestId is server-generated, owned by exactly one user, and single-use.
- Raw Prisma/PostgreSQL errors are never exposed; all errors use the `{ code, message }` contract.
- No secrets are logged or returned.
- **Out of scope for this assessment**: authentication/authorization (userId is a dev-supplied identifier; production would derive it from an authenticated principal) and real payment processing.

