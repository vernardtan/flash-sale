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
  // The interactive transaction callback is invoked directly with the mock tx.
  const tx = {
    checkout: {
      findUnique: jest.fn<() => Promise<unknown>>(),
      findUniqueOrThrow: jest.fn<() => Promise<unknown>>(),
      update: jest.fn<() => Promise<unknown>>(),
    },
    purchase: {
      findUnique: jest.fn<() => Promise<unknown>>(),
      findFirst: jest.fn<() => Promise<unknown>>(),
      create:
        jest.fn<(arg: { data: Record<string, unknown> }) => Promise<unknown>>(),
    },
    $queryRaw: jest.fn<(...args: unknown[]) => Promise<unknown[]>>(),
  };
  const prisma = {
    $transaction: jest.fn((callback: (txArg: unknown) => unknown) =>
      Promise.resolve(callback(tx)),
    ),
  };
  const saleService = {
    assertPurchasable: jest.fn<() => Promise<unknown>>(),
  };
  const clock = { now: () => NOW };

  const service = new TransactionService(
    prisma as unknown as PrismaService,
    saleService as unknown as SaleService,
    clock,
  );

  /** Route $queryRaw calls: the claim UPDATEs checkouts, the decrement UPDATEs products. */
  function mockRawQueries(opts: { claimRows: number; decrementRows: number }) {
    tx.$queryRaw.mockImplementation((...args: unknown[]) => {
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
  }

  beforeEach(() => {
    jest.clearAllMocks();
    tx.checkout.findUnique.mockResolvedValue(makeCheckout());
    tx.checkout.findUniqueOrThrow.mockResolvedValue(makeCheckout());
    tx.checkout.update.mockResolvedValue({});
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
    saleService.assertPurchasable.mockResolvedValue({
      flashSale: { id: 'flash-sale-1' },
    });
    mockRawQueries({ claimRows: 1, decrementRows: 1 });
  });

  it('rejects unknown requestIds', async () => {
    tx.checkout.findUnique.mockResolvedValue(null);
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.CHECKOUT_NOT_FOUND,
    });
  });

  it('rejects when the requestId belongs to a different user', async () => {
    tx.checkout.findUnique.mockResolvedValue(
      makeCheckout({ userId: 'someone-else' }),
    );
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.REQUEST_NOT_AUTHORIZED,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('maps a lost claim on a PROCESSING checkout to TRANSACTION_PROCESSING', async () => {
    const checkout = makeCheckout({ status: CheckoutStatus.PROCESSING });
    tx.checkout.findUnique.mockResolvedValue(checkout);
    tx.checkout.findUniqueOrThrow.mockResolvedValue(checkout);
    mockRawQueries({ claimRows: 0, decrementRows: 0 });
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.TRANSACTION_PROCESSING,
    });
  });

  it.each([CheckoutStatus.COMPLETED, CheckoutStatus.FAILED])(
    'maps a lost claim on a %s checkout to REQUEST_ALREADY_PROCESSED',
    async (status) => {
      const checkout = makeCheckout({ status });
      tx.checkout.findUnique.mockResolvedValue(checkout);
      tx.checkout.findUniqueOrThrow.mockResolvedValue(checkout);
      mockRawQueries({ claimRows: 0, decrementRows: 0 });
      await expect(service.execute(makeDto())).rejects.toMatchObject({
        code: ApiErrorCode.REQUEST_ALREADY_PROCESSED,
      });
    },
  );

  it('maps a lost claim on an EXPIRED checkout to CHECKOUT_EXPIRED', async () => {
    const checkout = makeCheckout({ status: CheckoutStatus.EXPIRED });
    tx.checkout.findUnique.mockResolvedValue(checkout);
    tx.checkout.findUniqueOrThrow.mockResolvedValue(checkout);
    mockRawQueries({ claimRows: 0, decrementRows: 0 });
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.CHECKOUT_EXPIRED,
    });
  });

  it('marks the checkout EXPIRED when it has passed its expiry', async () => {
    tx.checkout.findUnique.mockResolvedValue(
      makeCheckout({ expiresAt: new Date(NOW.getTime() - 1_000) }),
    );
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.CHECKOUT_EXPIRED,
    });
    expect(tx.checkout.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: CheckoutStatus.EXPIRED },
      }),
    );
  });

  it('marks the checkout FAILED when quantity is not 1 for a flash-sale product', async () => {
    tx.checkout.findUnique.mockResolvedValue(makeCheckout({ quantity: 2 }));
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.INVALID_QUANTITY,
    });
    expect(tx.checkout.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: CheckoutStatus.FAILED } }),
    );
  });

  it('marks the checkout FAILED when the sale is no longer valid', async () => {
    saleService.assertPurchasable.mockRejectedValue(ApiException.saleEnded());
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.SALE_ENDED,
    });
    expect(tx.checkout.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: CheckoutStatus.FAILED } }),
    );
  });

  it('marks the checkout FAILED when the user already purchased a flash-sale product', async () => {
    tx.purchase.findFirst.mockResolvedValue({ id: 'purchase-existing' });
    await expect(service.execute(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.ALREADY_PURCHASED,
    });
    expect(tx.purchase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', isFlashSale: true } }),
    );
    expect(tx.checkout.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: CheckoutStatus.FAILED } }),
    );
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
    expect(tx.checkout.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: CheckoutStatus.FAILED } }),
    );
    expect(tx.purchase.create).not.toHaveBeenCalled();
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
    expect(tx.checkout.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: CheckoutStatus.COMPLETED },
      }),
    );
  });

  it('maps a UNIQUE(user_id) violation to ALREADY_PURCHASED (rolled back)', async () => {
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
    // The error propagated out of the transaction callback → rollback.
    expect(tx.checkout.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: CheckoutStatus.COMPLETED },
      }),
    );
  });

  it('maps a UNIQUE(request_id) violation to REQUEST_ALREADY_PROCESSED', async () => {
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
  });

  it('rethrows unexpected errors without marking the checkout FAILED', async () => {
    tx.purchase.create.mockRejectedValue(new Error('connection lost'));
    await expect(service.execute(makeDto())).rejects.toThrow('connection lost');
    expect(tx.checkout.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: CheckoutStatus.FAILED } }),
    );
  });
});
