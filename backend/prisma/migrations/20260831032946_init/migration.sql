-- CreateEnum
CREATE TYPE "CheckoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "total_stock" INTEGER NOT NULL,
    "remaining_stock" INTEGER NOT NULL,
    "is_enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flash_sales" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "start_time" TIMESTAMPTZ(6) NOT NULL,
    "end_time" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "flash_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkouts" (
    "id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "payment_method" TEXT NOT NULL,
    "status" "CheckoutStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "payment_method" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "flash_sales_product_id_idx" ON "flash_sales"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "checkouts_request_id_key" ON "checkouts"("request_id");

-- CreateIndex
CREATE INDEX "checkouts_user_id_idx" ON "checkouts"("user_id");

-- CreateIndex
CREATE INDEX "checkouts_product_id_idx" ON "checkouts"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_user_id_key" ON "purchases"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_request_id_key" ON "purchases"("request_id");

-- CreateIndex
CREATE INDEX "purchases_product_id_idx" ON "purchases"("product_id");

-- AddForeignKey
ALTER TABLE "flash_sales" ADD CONSTRAINT "flash_sales_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "checkouts"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraints (hand-written: Prisma schema cannot express these).
-- These are part of the correctness backbone: they make invalid states
-- unrepresentable even if application validation is bypassed.

-- Inventory can never go negative or exceed the total allocation.
ALTER TABLE "products" ADD CONSTRAINT "products_total_stock_nonnegative" CHECK ("total_stock" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_remaining_stock_nonnegative" CHECK ("remaining_stock" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_remaining_stock_within_total" CHECK ("remaining_stock" <= "total_stock");

-- A sale window must be a non-empty interval.
ALTER TABLE "flash_sales" ADD CONSTRAINT "flash_sales_end_after_start" CHECK ("end_time" > "start_time");

-- Quantities are generic (> 0). The flash-sale rule quantity = 1 is a
-- business rule enforced in the application layer (Phase 4).
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_quantity_positive" CHECK ("quantity" > 0);
