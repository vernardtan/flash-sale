/**
 * Idempotent development seed.
 *
 * Creates the single flash-sale product and its flash-sale window using fixed
 * deterministic IDs, so it is safe to run repeatedly:
 * - Product: upserted; descriptive fields are refreshed, stock is only set on
 *   first creation (reset with `docker compose down -v` for a clean slate).
 * - FlashSale: upserted; the window is re-anchored on every run to
 *   [now - 1h, now + 7d] so the sale is always ACTIVE for local testing.
 *
 * Usage:
 *   docker compose exec backend npm run db:seed      (inside the stack)
 *   DATABASE_URL=postgresql://flash_sale:flash_sale_dev@localhost:5432/flash_sale npm run db:seed
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const PRODUCT_ID = '1c0e4b8a-7f6d-4e5a-9c3b-2d1f0e8a7b6c';
const FLASH_SALE_ID = '2d1f5c9b-8a7e-4f6b-8d4c-3e2a1f9b8c7d';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Point it at your database, e.g. ' +
        'postgresql://flash_sale:flash_sale_dev@localhost:5432/flash_sale',
    );
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

  try {
    const product = await prisma.product.upsert({
      where: { id: PRODUCT_ID },
      create: {
        id: PRODUCT_ID,
        name: 'Limited Edition Product',
        description: 'Limited-edition flash sale product',
        price: '1999.00',
        currency: 'PHP',
        totalStock: 100,
        remainingStock: 100,
        isEnabled: true,
      },
      update: {
        name: 'Limited Edition Product',
        description: 'Limited-edition flash sale product',
        price: '1999.00',
        currency: 'PHP',
        isEnabled: true,
      },
    });

    const now = Date.now();
    const startTime = new Date(now - 60 * 60 * 1000);
    const endTime = new Date(now + 7 * 24 * 60 * 60 * 1000);

    const flashSale = await prisma.flashSale.upsert({
      where: { id: FLASH_SALE_ID },
      create: {
        id: FLASH_SALE_ID,
        productId: product.id,
        startTime,
        endTime,
      },
      update: { startTime, endTime },
    });

    console.log('Seed applied:');
    console.log(
      `  product   ${product.id} "${product.name}" ` +
        `stock=${product.remainingStock}/${product.totalStock} ` +
        `${product.currency} ${product.price} enabled=${product.isEnabled}`,
    );
    console.log(
      `  flashSale ${flashSale.id} ${flashSale.startTime.toISOString()} -> ${flashSale.endTime.toISOString()}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
