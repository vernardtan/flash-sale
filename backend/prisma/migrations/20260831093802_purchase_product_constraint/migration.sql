-- DropIndex
DROP INDEX "purchases_user_id_key";

-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "is_flash_sale" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: existing purchases of flash-sale products are flagged so the
-- partial unique index below protects them.
UPDATE "purchases"
SET "is_flash_sale" = true
WHERE "product_id" IN (SELECT "product_id" FROM "flash_sales");

-- CreateIndex
CREATE INDEX "purchases_user_id_idx" ON "purchases"("user_id");

-- Partial unique index: one flash-sale purchase per user. Regular products
-- are not restricted by this index and may be repurchased.
CREATE UNIQUE INDEX "purchases_unique_user_flashsale"
ON "purchases"("user_id")
WHERE "is_flash_sale" = true;
