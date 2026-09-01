import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FlashSale, Prisma, Product } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { Clock } from '../common/clock.js';
import { ApiException } from '../common/errors/api.exception.js';

/**
 * Sale status is always derived, never persisted. Derivation priority
 * (first match wins):
 *
 *   feature flag disabled   → DISABLED
 *   product missing/disabled → DISABLED  (no sale scheduled → DISABLED)
 *   now < startTime         → UPCOMING
 *   now >= endTime          → ENDED
 *   remainingStock <= 0     → SOLD_OUT
 *   otherwise               → ACTIVE
 *
 * All comparisons are UTC (timestamptz in PostgreSQL, Date here).
 */
export enum SaleStatus {
  DISABLED = 'DISABLED',
  UPCOMING = 'UPCOMING',
  ACTIVE = 'ACTIVE',
  ENDED = 'ENDED',
  SOLD_OUT = 'SOLD_OUT',
}

export interface SaleStatusResponse {
  status: SaleStatus;
  productId: string | null;
  startTime: string | null;
  endTime: string | null;
  remainingStock: number | null;
}

export type DbClient = Prisma.TransactionClient | PrismaService;

@Injectable()
export class SaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {}

  /** Operational kill switch. Deliberately an env var, not database state. */
  isFlashSaleEnabled(): boolean {
    return this.config.get<string>('FLASH_SALE_ENABLED', 'true') === 'true';
  }

  /**
   * The flash-sale product is the one with a scheduled flash sale. This is a
   * single-product system; ordering by startTime keeps the choice
   * deterministic if development data ever contains more than one.
   */
  async getCurrentSale(
    db: DbClient = this.prisma,
  ): Promise<{ product: Product; flashSale: FlashSale } | null> {
    const sale = await db.flashSale.findFirst({
      orderBy: { startTime: 'desc' },
      include: { product: true },
    });
    return sale ? { product: sale.product, flashSale: sale } : null;
  }

  deriveStatus(
    product: Product | null,
    flashSale: FlashSale | null,
    now: Date = this.clock.now(),
  ): SaleStatus {
    if (!this.isFlashSaleEnabled()) return SaleStatus.DISABLED;
    if (!product || !product.isEnabled || !flashSale) {
      return SaleStatus.DISABLED;
    }
    if (now < flashSale.startTime) return SaleStatus.UPCOMING;
    if (now >= flashSale.endTime) return SaleStatus.ENDED;
    if (product.remainingStock <= 0) return SaleStatus.SOLD_OUT;
    return SaleStatus.ACTIVE;
  }

  async getStatus(): Promise<SaleStatusResponse> {
    const current = await this.getCurrentSale();
    const status = this.deriveStatus(
      current?.product ?? null,
      current?.flashSale ?? null,
    );
    return {
      status,
      productId: current?.product.id ?? null,
      startTime: current?.flashSale.startTime.toISOString() ?? null,
      endTime: current?.flashSale.endTime.toISOString() ?? null,
      remainingStock: current?.product.remainingStock ?? null,
    };
  }

  /**
   * Shared gate for checkout creation and transaction-time revalidation.
   * Same evaluation order as deriveStatus, but with fine-grained error codes.
   * Returns the verified product + flash sale for reuse by the caller.
   */
  async assertPurchasable(
    productId: string,
    db: DbClient = this.prisma,
  ): Promise<{ product: Product; flashSale: FlashSale }> {

    const product = await db.product.findUnique({
      where: { id: productId },
      include: {
        flashSales: { orderBy: { startTime: 'desc' }, take: 1 },
      },
    });
    if (!product) throw ApiException.productNotFound();
    if (!product.isEnabled) throw ApiException.productDisabled();

    const flashSale = product.flashSales[0];
    if (flashSale) {
      if (!this.isFlashSaleEnabled()) throw ApiException.saleDisabled();
      const now = this.clock.now();
      if (now < flashSale.startTime) throw ApiException.saleUpcoming();
      if (now >= flashSale.endTime) throw ApiException.saleEnded();
      if (product.remainingStock <= 0) throw ApiException.soldOut();
    }

    return { product, flashSale };
  }
}
