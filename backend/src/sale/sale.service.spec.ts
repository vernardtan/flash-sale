import type { ConfigService } from '@nestjs/config';
import type { FlashSale, Product } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service.js';
import { SaleService, SaleStatus } from './sale.service.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-1',
    name: 'Limited Edition Product',
    description: null,
    price: '1999.00',
    currency: 'PHP',
    totalStock: 100,
    remainingStock: 100,
    isEnabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as Product;
}

function makeFlashSale(overrides: Partial<FlashSale> = {}): FlashSale {
  return {
    id: 'sale-1',
    productId: 'product-1',
    startTime: new Date('2026-06-15T00:00:00.000Z'),
    endTime: new Date('2026-06-16T00:00:00.000Z'),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('SaleService.deriveStatus', () => {
  const clock = { now: () => NOW };
  let flagEnabled = true;

  const config = {
    get: (key: string, defaultValue?: string) =>
      key === 'FLASH_SALE_ENABLED'
        ? String(flagEnabled)
        : (defaultValue ?? undefined),
  } as ConfigService;

  // deriveStatus never touches the database.
  const service = new SaleService({} as PrismaService, config, clock);

  beforeEach(() => {
    flagEnabled = true;
  });

  it('is ACTIVE when flag, product, window, and stock are all valid', () => {
    expect(service.deriveStatus(makeProduct(), makeFlashSale())).toBe(
      SaleStatus.ACTIVE,
    );
  });

  it('is DISABLED when the feature flag is off, with top priority', () => {
    flagEnabled = false;
    expect(service.deriveStatus(makeProduct(), makeFlashSale())).toBe(
      SaleStatus.DISABLED,
    );
  });

  it('is DISABLED when the product is missing', () => {
    expect(service.deriveStatus(null, makeFlashSale())).toBe(
      SaleStatus.DISABLED,
    );
  });

  it('is DISABLED when the product is disabled', () => {
    expect(
      service.deriveStatus(makeProduct({ isEnabled: false }), makeFlashSale()),
    ).toBe(SaleStatus.DISABLED);
  });

  it('is DISABLED when no flash sale is scheduled', () => {
    expect(service.deriveStatus(makeProduct(), null)).toBe(SaleStatus.DISABLED);
  });

  it('is UPCOMING before the start time', () => {
    const sale = makeFlashSale({
      startTime: new Date('2026-06-15T13:00:00.000Z'),
      endTime: new Date('2026-06-16T00:00:00.000Z'),
    });
    expect(service.deriveStatus(makeProduct(), sale)).toBe(SaleStatus.UPCOMING);
  });

  it('is ENDED at exactly the end time (end is exclusive)', () => {
    const sale = makeFlashSale({
      startTime: new Date('2026-06-15T00:00:00.000Z'),
      endTime: NOW,
    });
    expect(service.deriveStatus(makeProduct(), sale)).toBe(SaleStatus.ENDED);
  });

  it('is SOLD_OUT within the window when stock is exhausted', () => {
    expect(
      service.deriveStatus(makeProduct({ remainingStock: 0 }), makeFlashSale()),
    ).toBe(SaleStatus.SOLD_OUT);
  });

  it('prioritizes ENDED over SOLD_OUT when both apply', () => {
    const sale = makeFlashSale({
      startTime: new Date('2026-06-14T00:00:00.000Z'),
      endTime: new Date('2026-06-15T00:00:00.000Z'),
    });
    expect(service.deriveStatus(makeProduct({ remainingStock: 0 }), sale)).toBe(
      SaleStatus.ENDED,
    );
  });

  it('prioritizes the feature flag over every other condition', () => {
    flagEnabled = false;
    const sale = makeFlashSale({
      startTime: new Date('2026-06-16T00:00:00.000Z'),
      endTime: new Date('2026-06-17T00:00:00.000Z'),
    });
    expect(service.deriveStatus(makeProduct({ remainingStock: 0 }), sale)).toBe(
      SaleStatus.DISABLED,
    );
  });
});
