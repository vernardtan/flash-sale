import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { Product } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service.js';
import { ApiErrorCode } from '../common/errors/api-error-code.enum.js';
import { ApiException } from '../common/errors/api.exception.js';
import type { SaleService } from '../sale/sale.service.js';
import { CheckoutService } from './checkout.service.js';
import type { CreateCheckoutDto } from './dto/create-checkout.dto.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');

const product = {
  id: '1c0e4b8a-7f6d-4e5a-9c3b-2d1f0e8a7b6c',
  name: 'Limited Edition Product',
  price: { toFixed: (digits: number) => (1999).toFixed(digits) },
  currency: 'PHP',
  remainingStock: 100,
  isEnabled: true,
} as unknown as Product;

const flashSale = { id: 'flash-sale-1' };

function makeDto(
  overrides: Partial<CreateCheckoutDto> = {},
): CreateCheckoutDto {
  return {
    userId: 'user-1',
    productId: product.id,
    quantity: 1,
    paymentMethod: 'GCASH',
    ...overrides,
  };
}

describe('CheckoutService', () => {
  const saleService = {
    assertPurchasable:
      jest.fn<
        () => Promise<{ product: Product; flashSale: { id: string } | null }>
      >(),
  };
  const prisma = {
    purchase: { findUnique: jest.fn<() => Promise<unknown>>(), findFirst: jest.fn<() => Promise<unknown>>() },
    checkout: {
      create:
        jest.fn<(arg: { data: Record<string, unknown> }) => Promise<unknown>>(),
    },
    product: { update: jest.fn<() => Promise<unknown>>() },
  };
  const config = {
    get: (key: string, defaultValue?: unknown) =>
      key === 'CHECKOUT_EXPIRATION_SECONDS' ? 900 : defaultValue,
  } as ConfigService;
  const clock = { now: () => NOW };

  const service = new CheckoutService(
    prisma as unknown as PrismaService,
    saleService as unknown as SaleService,
    config,
    clock,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    saleService.assertPurchasable.mockResolvedValue({ product, flashSale });
    prisma.purchase.findFirst.mockResolvedValue(null);
    prisma.checkout.create.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'checkout-1',
        ...data,
        unitPrice: { toFixed: () => '1999.00' },
      }),
    );
  });

  it('rejects quantity other than 1 for a flash-sale product', async () => {
    await expect(
      service.createCheckout(makeDto({ quantity: 2 })),
    ).rejects.toMatchObject({ code: ApiErrorCode.INVALID_QUANTITY });
    expect(saleService.assertPurchasable).toHaveBeenCalledWith(product.id);
  });

  it('allows quantity greater than 1 for a regular product', async () => {
    saleService.assertPurchasable.mockResolvedValue({
      product,
      flashSale: null,
    });
    await expect(
      service.createCheckout(makeDto({ quantity: 3 })),
    ).resolves.toMatchObject({ quantity: 3 });
  });

  it('rejects non-positive quantity for a regular product', async () => {
    saleService.assertPurchasable.mockResolvedValue({
      product,
      flashSale: null,
    });
    await expect(
      service.createCheckout(makeDto({ quantity: 0 })),
    ).rejects.toMatchObject({ code: ApiErrorCode.INVALID_QUANTITY });
  });

  it('rejects unsupported payment methods', async () => {
    await expect(
      service.createCheckout(makeDto({ paymentMethod: 'BITCOIN' })),
    ).rejects.toMatchObject({ code: ApiErrorCode.INVALID_PAYMENT_METHOD });
  });

  it('rejects users who already purchased a flash-sale product', async () => {
    prisma.purchase.findFirst.mockResolvedValue({ id: 'purchase-1' });
    await expect(service.createCheckout(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.ALREADY_PURCHASED,
    });
    expect(prisma.purchase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', isFlashSale: true } }),
    );
  });

  it('propagates sale-state errors from assertPurchasable', async () => {
    saleService.assertPurchasable.mockRejectedValue(ApiException.saleEnded());
    await expect(service.createCheckout(makeDto())).rejects.toMatchObject({
      code: ApiErrorCode.SALE_ENDED,
    });
  });

  it('creates a PENDING checkout with server-generated requestId and price snapshot', async () => {
    const result = await service.createCheckout(makeDto());

    const createArg = prisma.checkout.create.mock.calls[0][0];
    expect(createArg.data.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(createArg.data.userId).toBe('user-1');
    expect(createArg.data.unitPrice).toBe(product.price);
    expect(createArg.data.currency).toBe('PHP');
    expect(createArg.data.expiresAt).toEqual(new Date(NOW.getTime() + 900_000));

    expect(result.status).toBe('PENDING');
    expect(result.requestId).toBe(createArg.data.requestId);
    expect(result.unitPrice).toBe('1999.00');
  });

  it('does not decrement or reserve stock when creating a checkout', async () => {
    await service.createCheckout(makeDto());
    expect(prisma.product.update).not.toHaveBeenCalled();
  });
});
