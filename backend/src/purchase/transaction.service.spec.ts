import { jest } from '@jest/globals';
import { CheckoutStatus, Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service.js';
import { ApiErrorCode } from '../common/errors/api-error-code.enum.js';
import { ApiException } from '../common/errors/api.exception.js';
import type { SaleService } from '../sale/sale.service.js';
import { TransactionService } from './transaction.service.js';
import type { CreateTransactionDto } from './dto/create-transaction.dto.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const REQUEST_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

function makeCheckout(overrides: Record<string, unknown> = {}) {
  return {
    id: 'checkout-1',
    requestId: REQUEST_ID,
    userId: 'user-1',
    productId: '1c0e4b8a-7f6d-4e5a-9c3b-2d1f0e8a7b6c',
    quantity: 1,
    unitPrice: new Prisma.Decimal('1999.00'),
    currency: 'PHP',
    paymentMethod: 'GCASH',
    status: CheckoutStatus.PENDING,
    expiresAt: new Date(NOW.getTime() + 900_000),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDto(): CreateTransactionDto {
  return { requestId: REQUEST_ID, userId: 'user-1' };
}

describe('TransactionService', () => {
  // Transaction callback mocks.
  const tx = {
    purchase: {
      findUnique: jest.fn<() => Promise<unknown>>(),
      findFirst: jest.fn<() => Promise<unknown>>(),
      create:
        jest.fn<(arg: { data: Record<string, unknown> }) => Promise<unknown>>(),
    },
    $queryRaw: jest.fn<(...args: unknown[]) => Promise<unknown[]>>(),
    $executeRaw: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };

  // Main Prisma client mocks.
  const prisma = {
    checkout: {
      findUnique: jest.fn<() => Promise<unknown>>(),
      findUniqueOrThrow: jest.fn<() => Promise<unknown>>(),
    },
    $queryRaw: jest.fn<(...args: unknown[]) => Promise<unknown[]>>(),
    $executeRaw: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    $transaction: jest.fn((callback: (txArg: unknown) => unknown) =>
      Promise.resolve(callback(tx)),
    ),
  };
  const saleService = {
    assertPurchasable: jest.fn<() => Promise<unknown>>(),
  };
  const clock = { now: () => NOW };
  const config = { get: jest.fn<(_key: string, fallback: number) => number>() };

  const service = new TransactionService(
    prisma as unknown as PrismaService,
    saleService as unknown as SaleService,
    clock,
    config as unknown as import('@nestjs/config').ConfigService,
  );

  /** Route raw queries: claim UPDATEs checkouts, decrement UPDATEs products. */
  function mockRawQueries(opts: { claimRows: number; decrementRows: number }) {
    const claimQuery = prisma.$queryRaw;
    claimQuery.mockImplementation((...args: unknown[]) => {
      const sql = (args[0] as string[]).join('?');
      if (sql.includes('UPDATE checkouts')) {
        return Promise.resolve(
          Array.from({ length: opts.claimRows }, () => ({ id: 'checkout-1' })),
        );
      }
      if (sql.includes('UPDATE products')) {
        return Promise.resolve(
          Array.from({ length: opts.decrementRows }, () => ({
            id: 'product-1',
          })),
        );
      }
      return Promise.resolve([]);
    });

    tx.$queryRaw.mockImplementation((...args: unknown[]) => {
      const sql = (args[0] as string[]).join('?');
      if (sql.includes('UPDATE products')) {
        return Promise.resolve(
          Array.from({ length: opts.decrementRows }, () => ({
            id: 'product-1',
          })),
        );
      }
      return Promise.resolve([]);
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockImplementation((_key, fallback) => fallback);
    prisma.checkout.findUnique.mockResolvedValue(makeCheckout());
    prisma.checkout.findUniqueOrThrow.mockResolvedValue(makeCheckout());
    prisma.$executeRaw.mockResolvedValue(0);
    tx.purchase.findUnique.mockResolvedValue(null);
    tx.purchase.findFirst.mockResolvedValue(null);
    tx.purchase.create.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'purchase-1',
        createdAt: NOW,
        unitPrice: { toFixed: () => '1999.00' },
        totalAmount: { toFixed: () => '1999.00' },
        ...data,
      }),
    );
    tx.$executeRaw.mockResolvedValue(0);
    saleService.assertPurchasable.mockResolvedValue({
      flashSale: { id: 'flash-sale-1' },
    });
    mockRawQueries({ claimRows: 1, decrementRows: 1 });
  });

  it('rejects unknown requestIds', async () => {
    prisma.checkout.findUnique.mockResolvedValue(null);
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.CHECKOUT_NOT_FOUND,
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects when the requestId belongs to a different user', async () => {
    prisma.checkout.findUnique.mockResolvedValue(
      makeCheckout({ userId: 'someone-else' }),
    );
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.REQUEST_NOT_AUTHORIZED,
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('maps a PROCESSING checkout to TRANSACTION_PROCESSING while fresh', async () => {
    const checkout = makeCheckout({ status: CheckoutStatus.PROCESSING });
    prisma.checkout.findUnique.mockResolvedValue(checkout);
    prisma.checkout.findUniqueOrThrow.mockResolvedValue(checkout);
    mockRawQueries({ claimRows: 0, decrementRows: 0 });
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.TRANSACTION_PROCESSING,
    });
  });

  it('recovers a stale PROCESSING checkout to FAILED and returns REQUEST_ALREADY_PROCESSED', async () => {
    const staleUpdatedAt = new Date(NOW.getTime() - 400_000);
    const checkout = makeCheckout({
      status: CheckoutStatus.PROCESSING,
      updatedAt: staleUpdatedAt,
    });
    prisma.checkout.findUnique.mockResolvedValue(checkout);
    prisma.checkout.findUniqueOrThrow.mockResolvedValue(checkout);
    mockRawQueries({ claimRows: 0, decrementRows: 0 });

    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.REQUEST_ALREADY_PROCESSED,
    });
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it.each([CheckoutStatus.COMPLETED, CheckoutStatus.FAILED])(
    'maps a %s checkout to REQUEST_ALREADY_PROCESSED',
    async (status) => {
      const checkout = makeCheckout({ status });
      prisma.checkout.findUnique.mockResolvedValue(checkout);
      prisma.checkout.findUniqueOrThrow.mockResolvedValue(checkout);
      mockRawQueries({ claimRows: 0, decrementRows: 0 });
      await expect(service.execute(makeDto())).rejects.toMatchObject({
        code: ApiErrorCode.REQUEST_ALREADY_PROCESSED,
      });
    },
  );

  it('maps an EXPIRED checkout to CHECKOUT_EXPIRED', async () => {
    const checkout = makeCheckout({ status: CheckoutStatus.EXPIRED });
    prisma.checkout.findUnique.mockResolvedValue(checkout);
    prisma.checkout.findUniqueOrThrow.mockResolvedValue(checkout);
    mockRawQueries({ claimRows: 0, decrementRows: 0 });
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.CHECKOUT_EXPIRED,
    });
  });

  it('marks the checkout EXPIRED when it has passed its expiry inside the purchase transaction', async () => {
    prisma.checkout.findUnique.mockResolvedValue(
      makeCheckout({ expiresAt: new Date(NOW.getTime() - 1_000) }),
    );
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.CHECKOUT_EXPIRED,
    });
    expect(tx.$executeRaw).toHaveBeenCalled();
    const rawCalls = tx.$executeRaw.mock.calls as unknown[][];
    const updateCall = rawCalls.find((call) => {
      const sql = (call[0] as string[]).join('?');
      // markStatus interpolates status as the first value.
      return sql.includes('UPDATE checkouts') && call[1] === 'EXPIRED';
    });
    expect(updateCall).toBeTruthy();
  });

  it('marks the checkout FAILED when quantity is not 1 for a flash-sale product', async () => {
    prisma.checkout.findUnique.mockResolvedValue(makeCheckout({ quantity: 2 }));
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.INVALID_QUANTITY,
    });
    const rawCalls = tx.$executeRaw.mock.calls as unknown[][];
    const updateCall = rawCalls.find((call) => {
      const sql = (call[0] as string[]).join('?');
      return sql.includes('UPDATE checkouts') && call[1] === 'FAILED';
    });
    expect(updateCall).toBeTruthy();
  });

  it('marks the checkout FAILED when the sale is no longer valid', async () => {
    saleService.assertPurchasable.mockRejectedValue(ApiException.saleEnded());
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.SALE_ENDED,
    });
    const rawCalls = tx.$executeRaw.mock.calls as unknown[][];
    const updateCall = rawCalls.find((call) => {
      const sql = (call[0] as string[]).join('?');
      return sql.includes('UPDATE checkouts') && call[1] === 'FAILED';
    });
    expect(updateCall).toBeTruthy();
  });

  it('marks the checkout FAILED when the user already purchased a flash-sale product', async () => {
    tx.purchase.findFirst.mockResolvedValue({ id: 'purchase-existing' });
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.ALREADY_PURCHASED,
    });
    expect(tx.purchase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', isFlashSale: true } }),
    );
    const rawCalls = tx.$executeRaw.mock.calls as unknown[][];
    const updateCall = rawCalls.find((call) => {
      const sql = (call[0] as string[]).join('?');
      return sql.includes('UPDATE checkouts') && call[1] === 'FAILED';
    });
    expect(updateCall).toBeTruthy();
    expect(tx.purchase.create).not.toHaveBeenCalled();
  });

  it('does not block repeat purchases of a regular product', async () => {
    saleService.assertPurchasable.mockResolvedValue({ flashSale: null });
    tx.purchase.findFirst.mockResolvedValue({ id: 'purchase-existing' });
    const result = await service.execute(makeDto());

    expect(result.status).toBe('COMPLETED');
    // For regular products the one-per-user check is skipped entirely.
    expect(tx.purchase.findFirst).not.toHaveBeenCalled();
    expect(tx.purchase.create).toHaveBeenCalled();

    const createArg = tx.purchase.create.mock.calls[0][0];
    expect(createArg.data.isFlashSale).toBe(false);
  });

  it('marks the checkout FAILED and returns SOLD_OUT when the atomic decrement finds no stock', async () => {
    mockRawQueries({ claimRows: 1, decrementRows: 0 });
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.SOLD_OUT,
    });
    const rawCalls = tx.$executeRaw.mock.calls as unknown[][];
    const updateCall = rawCalls.find((call) => {
      const sql = (call[0] as string[]).join('?');
      return sql.includes('UPDATE checkouts') && call[1] === 'FAILED';
    });
    expect(updateCall).toBeTruthy();
    expect(tx.purchase.create).not.toHaveBeenCalled();
  });

  it('decrements stock with remaining_stock >= quantity', async () => {
    // Use a regular product so quantity > 1 is valid.
    saleService.assertPurchasable.mockResolvedValue({ flashSale: null });
    prisma.checkout.findUnique.mockResolvedValue(makeCheckout({ quantity: 3 }));
    mockRawQueries({ claimRows: 1, decrementRows: 1 });
    await service.execute(makeDto());

    const rawCalls = tx.$queryRaw.mock.calls as unknown[][];
    const decrementCall = rawCalls.find((call) => {
      const sql = (call[0] as string[]).join('?');
      return sql.includes('UPDATE products');
    });
    expect(decrementCall).toBeTruthy();
    const sql = (decrementCall![0] as string[]).join('?');
    expect(sql).toContain('remaining_stock >= ?');
    // Params: quantity (SET), productId, quantity (WHERE guard).
    expect(decrementCall![3]).toBe(3);
  });

  it('completes the purchase from the checkout price snapshot', async () => {
    const result = await service.execute(makeDto());

    expect(result.status).toBe('COMPLETED');
    expect(result.purchaseId).toBe('purchase-1');
    expect(result.requestId).toBe(REQUEST_ID);

    const createArg = tx.purchase.create.mock.calls[0][0];
    expect(createArg.data.userId).toBe('user-1');
    expect(createArg.data.requestId).toBe(REQUEST_ID);
    expect(String(createArg.data.totalAmount)).toBe('1999');
    const rawCalls = tx.$executeRaw.mock.calls as unknown[][];
    const completedCall = rawCalls.find((call) => {
      const sql = (call[0] as string[]).join('?');
      return sql.includes('UPDATE checkouts') && call[1] === 'COMPLETED';
    });
    expect(completedCall).toBeTruthy();
  });

  it('maps a UNIQUE(user_id) violation to ALREADY_PURCHASED and marks FAILED', async () => {
    tx.purchase.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { target: ['user_id'] },
      }),
    );
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.ALREADY_PURCHASED,
    });
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('maps a UNIQUE(request_id) violation to REQUEST_ALREADY_PROCESSED and marks FAILED', async () => {
    tx.purchase.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { target: ['request_id'] },
      }),
    );
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.REQUEST_ALREADY_PROCESSED,
    });
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('marks the checkout FAILED on unexpected errors and rethrows', async () => {
    tx.purchase.create.mockRejectedValue(new Error('connection lost'));
    await expect(service.execute(makeDto())).rejects.toThrow('connection lost');
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('immediately returns TRANSACTION_PROCESSING for a concurrent claim without waiting', async () => {
    // First call sees PENDING but claim returns 0 rows (another request won).
    // The service re-reads and finds PROCESSING.
    const checkout = makeCheckout({ status: CheckoutStatus.PROCESSING });
    prisma.checkout.findUnique.mockResolvedValue(makeCheckout());
    prisma.checkout.findUniqueOrThrow.mockResolvedValue(checkout);
    mockRawQueries({ claimRows: 0, decrementRows: 0 });
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.TRANSACTION_PROCESSING,
    });
  });
});