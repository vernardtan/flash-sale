import { jest } from '@jest/globals';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  cleanDatabase,
  runSeed,
  setupTestDatabase,
  TEST_DATABASE_URL,
} from './test-db.js';

/**
 * Database schema guarantees, verified against a real PostgreSQL instance
 * (flash_sale_test, created and migrated by setupTestDatabase).
 *
 * These constraints are the persistence-layer backbone of the flash-sale
 * invariants: no overselling, one purchase per user, valid sale windows.
 */
jest.setTimeout(180_000);

describe('Database schema (e2e)', () => {
  let prisma: PrismaClient;

  const productData = {
    name: 'Test Product',
    price: '1999.00',
    currency: 'PHP',
    totalStock: 10,
    remainingStock: 10,
    isEnabled: true,
  };

  beforeAll(async () => {
    prisma = await setupTestDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createProduct(
    overrides: Partial<typeof productData> = {},
  ): Promise<{ id: string }> {
    return prisma.product.create({
      data: { ...productData, ...overrides },
      select: { id: true },
    });
  }

  async function createCheckout(productId: string, requestId: string) {
    const now = Date.now();
    return prisma.checkout.create({
      data: {
        requestId,
        userId: `user-${requestId}`,
        productId,
        quantity: 1,
        unitPrice: '1999.00',
        currency: 'PHP',
        paymentMethod: 'MOCK_CARD',
        expiresAt: new Date(now + 15 * 60 * 1000),
      },
    });
  }

  /** Assert a Prisma known-request error code (e.g. P2002, P2003). */
  async function expectPrismaError(promise: Promise<unknown>, code: string) {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe(code);
  }

  /** Assert a CHECK constraint violation surfaces from PostgreSQL (23514). */
  async function expectCheckViolation(
    promise: Promise<unknown>,
    constraint: string,
  ) {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    expect(String(error)).toContain(constraint);
  }

  describe('foreign keys', () => {
    it('rejects a checkout for a nonexistent product', async () => {
      await expectPrismaError(
        createCheckout('00000000-0000-0000-0000-000000000000', 'req-fk-1'),
        'P2003',
      );
    });

    it('rejects a purchase for a nonexistent product', async () => {
      await expectPrismaError(
        prisma.purchase.create({
          data: {
            userId: 'user-fk',
            productId: '00000000-0000-0000-0000-000000000000',
            requestId: 'req-fk-2',
            quantity: 1,
            unitPrice: '1999.00',
            totalAmount: '1999.00',
            currency: 'PHP',
            paymentMethod: 'MOCK_CARD',
          },
        }),
        'P2003',
      );
    });

    it('links a purchase to its checkout via request_id', async () => {
      const product = await createProduct();
      await createCheckout(product.id, 'req-link-1');

      await expectPrismaError(
        prisma.purchase.create({
          data: {
            userId: 'user-link',
            productId: product.id,
            requestId: 'req-does-not-exist',
            quantity: 1,
            unitPrice: '1999.00',
            totalAmount: '1999.00',
            currency: 'PHP',
            paymentMethod: 'MOCK_CARD',
          },
        }),
        'P2003',
      );
    });
  });

  describe('uniqueness', () => {
    it('rejects a second flash-sale purchase for the same user (one item per user)', async () => {
      const product = await createProduct();
      await createCheckout(product.id, 'req-dup-1');
      await createCheckout(product.id, 'req-dup-2');

      const purchaseData = {
        productId: product.id,
        quantity: 1,
        unitPrice: '1999.00',
        totalAmount: '1999.00',
        currency: 'PHP',
        paymentMethod: 'MOCK_CARD',
        isFlashSale: true,
      };
      await prisma.purchase.create({
        data: { ...purchaseData, userId: 'user-dup', requestId: 'req-dup-1' },
      });

      await expectPrismaError(
        prisma.purchase.create({
          data: { ...purchaseData, userId: 'user-dup', requestId: 'req-dup-2' },
        }),
        'P2002',
      );
    });

    it('allows the same user to purchase a regular product multiple times', async () => {
      const product = await createProduct();
      await createCheckout(product.id, 'req-reg-1');
      await createCheckout(product.id, 'req-reg-2');

      const purchaseData = {
        productId: product.id,
        quantity: 1,
        unitPrice: '1999.00',
        totalAmount: '1999.00',
        currency: 'PHP',
        paymentMethod: 'MOCK_CARD',
        isFlashSale: false,
      };

      await expect(
        prisma.purchase.create({
          data: {
            ...purchaseData,
            userId: 'user-repeat',
            requestId: 'req-reg-1',
          },
        }),
      ).resolves.toBeDefined();

      await expect(
        prisma.purchase.create({
          data: {
            ...purchaseData,
            userId: 'user-repeat',
            requestId: 'req-reg-2',
          },
        }),
      ).resolves.toBeDefined();

      const count = await prisma.purchase.count({
        where: { userId: 'user-repeat' },
      });
      expect(count).toBe(2);
    });

    it('rejects duplicate checkout request IDs', async () => {
      const product = await createProduct();
      await createCheckout(product.id, 'req-dup-checkout');

      await expectPrismaError(
        createCheckout(product.id, 'req-dup-checkout'),
        'P2002',
      );
    });

    it('rejects two purchases for the same checkout request', async () => {
      const product = await createProduct();
      await createCheckout(product.id, 'req-dup-purchase');

      const purchaseData = {
        productId: product.id,
        requestId: 'req-dup-purchase',
        quantity: 1,
        unitPrice: '1999.00',
        totalAmount: '1999.00',
        currency: 'PHP',
        paymentMethod: 'MOCK_CARD',
      };
      await prisma.purchase.create({
        data: { ...purchaseData, userId: 'user-a' },
      });

      await expectPrismaError(
        prisma.purchase.create({ data: { ...purchaseData, userId: 'user-b' } }),
        'P2002',
      );
    });
  });

  describe('checkout status enum', () => {
    it('persists PROCESSING and FAILED statuses', async () => {
      const product = await createProduct();
      const now = Date.now();

      const processing = await prisma.checkout.create({
        data: {
          requestId: 'req-processing',
          userId: 'user-processing',
          productId: product.id,
          quantity: 1,
          unitPrice: '1999.00',
          currency: 'PHP',
          paymentMethod: 'MOCK_CARD',
          status: 'PROCESSING',
          expiresAt: new Date(now + 15 * 60 * 1000),
        },
      });
      expect(processing.status).toBe('PROCESSING');

      const failed = await prisma.checkout.create({
        data: {
          requestId: 'req-failed',
          userId: 'user-failed',
          productId: product.id,
          quantity: 1,
          unitPrice: '1999.00',
          currency: 'PHP',
          paymentMethod: 'MOCK_CARD',
          status: 'FAILED',
          expiresAt: new Date(now + 15 * 60 * 1000),
        },
      });
      expect(failed.status).toBe('FAILED');
    });
  });

  describe('check constraints', () => {
    it('rejects negative remaining_stock', async () => {
      await expectCheckViolation(
        createProduct({ remainingStock: -1 }),
        'products_remaining_stock_nonnegative',
      );
    });

    it('rejects remaining_stock greater than total_stock', async () => {
      await expectCheckViolation(
        createProduct({ totalStock: 5, remainingStock: 6 }),
        'products_remaining_stock_within_total',
      );
    });

    it('rejects negative total_stock', async () => {
      // total_stock = -1 also breaks remaining_stock <= total_stock, so
      // PostgreSQL may report either stock constraint; what matters is that
      // the row is unrepresentable.
      const error = await createProduct({
        totalStock: -1,
        remainingStock: 0,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(String(error)).toContain('violates check constraint');
      expect(String(error)).toContain('23514');
    });

    it('rejects a checkout with zero quantity', async () => {
      const product = await createProduct();
      const now = Date.now();
      await expectCheckViolation(
        prisma.checkout.create({
          data: {
            requestId: 'req-qty-0',
            userId: 'user-qty-0',
            productId: product.id,
            quantity: 0,
            unitPrice: '1999.00',
            currency: 'PHP',
            paymentMethod: 'MOCK_CARD',
            expiresAt: new Date(now + 15 * 60 * 1000),
          },
        }),
        'checkouts_quantity_positive',
      );
    });

    it('rejects a purchase with zero quantity', async () => {
      const product = await createProduct();
      await createCheckout(product.id, 'req-pqty-0');
      await expectCheckViolation(
        prisma.purchase.create({
          data: {
            userId: 'user-pqty-0',
            productId: product.id,
            requestId: 'req-pqty-0',
            quantity: 0,
            unitPrice: '1999.00',
            totalAmount: '0.00',
            currency: 'PHP',
            paymentMethod: 'MOCK_CARD',
          },
        }),
        'purchases_quantity_positive',
      );
    });

    it('rejects a flash sale whose end is not after its start', async () => {
      const product = await createProduct();
      const now = new Date();
      await expectCheckViolation(
        prisma.flashSale.create({
          data: {
            productId: product.id,
            startTime: now,
            endTime: now,
          },
        }),
        'flash_sales_end_after_start',
      );
    });
  });

  describe('seed', () => {
    it('is idempotent and preserves stock across runs', async () => {
      runSeed();
      runSeed();

      const products = await prisma.product.findMany({ orderBy: { createdAt: 'asc' } });
      const flashSales = await prisma.flashSale.findMany();
      // Seed now creates both a flash-sale and a regular product.
      expect(products).toHaveLength(2);
      expect(flashSales).toHaveLength(1);

      const flashProduct = products.find((p) => p.name === 'Limited Edition Product')!;
      expect(flashProduct).toMatchObject({
        name: 'Limited Edition Product',
        currency: 'PHP',
        totalStock: 100,
        remainingStock: 100,
        isEnabled: true,
      });
      expect(flashProduct.price.toFixed(2)).toBe('1999.00');
      expect(flashSales[0].productId).toBe(flashProduct.id);
      expect(flashSales[0].endTime.getTime()).toBeGreaterThan(
        flashSales[0].startTime.getTime(),
      );
    });

    it('accepts the DATABASE_URL override', () => {
      // Guards against the seed silently targeting the dev database.
      expect(TEST_DATABASE_URL).toContain('flash_sale_test');
    });
  });
});
