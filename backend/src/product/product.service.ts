import { Injectable } from '@nestjs/common';
import type { FlashSale, Product } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { SaleService, SaleStatus } from '../sale/sale.service.js';

export interface ProductEligibility {
  eligible: boolean;
  reason: string | null;
}

export interface ProductResponse {
  id: string;
  name: string;
  description: string | null;
  /** Money serialized as a fixed-precision string, never a float. */
  price: string;
  currency: string;
  totalStock: number;
  remainingStock: number;
  sale: {
    status: SaleStatus;
    startTime: string;
    endTime: string;
  } | null;
  /** Present only when a userId query parameter was supplied. */
  eligibility: ProductEligibility | null;
  buyNowAvailable: boolean;
}

@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly saleService: SaleService,
  ) {}

  /**
   * Lists products with flash-sale context. `userId` is a development-only
   * identity hint (query param); production would derive the caller from an
   * authenticated principal. It is used solely to compute that user's
   * eligibility and never exposes other users' data.
   */
  async listProducts(
    userId?: string,
  ): Promise<{ products: ProductResponse[] }> {
    const products = await this.prisma.product.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        flashSales: { orderBy: { startTime: 'desc' }, take: 1 },
      },
    });

    const purchasedFlashSaleIds = userId
      ? new Set(
          (
            await this.prisma.purchase.findMany({
              where: { userId, isFlashSale: true },
              select: { productId: true },
            })
          ).map((p) => p.productId),
        )
      : null;

    return {
      products: products.map((product) =>
        this.toResponse(
          product,
          product.flashSales[0] ?? null,
          userId,
          purchasedFlashSaleIds,
        ),
      ),
    };
  }

  private toResponse(
    product: Product,
    flashSale: FlashSale | null,
    userId: string | undefined,
    purchasedFlashSaleIds: Set<string> | null,
  ): ProductResponse {
    const status = this.saleService.deriveStatus(product, flashSale);

    let eligibility: ProductEligibility | null = null;
    if (userId) {
      // Only flash-sale products carry the one-per-user restriction; regular
      // products may be repurchased freely.
      const alreadyPurchased =
        flashSale && (purchasedFlashSaleIds?.has(product.id) ?? false);
      eligibility = alreadyPurchased
        ? { eligible: false, reason: 'ALREADY_PURCHASED' }
        : { eligible: true, reason: null };
    }

    return {
      id: product.id,
      name: product.name,
      description: product.description,
      price: product.price.toFixed(2),
      currency: product.currency,
      totalStock: product.totalStock,
      remainingStock: product.remainingStock,
      sale: flashSale
        ? {
            status,
            startTime: flashSale.startTime.toISOString(),
            endTime: flashSale.endTime.toISOString(),
          }
        : null,
      eligibility,
      buyNowAvailable:
        status === SaleStatus.ACTIVE && eligibility?.eligible !== false,
    };
  }
}
