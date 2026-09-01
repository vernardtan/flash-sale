import { Injectable } from '@nestjs/common';
import type { Purchase } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { ApiException } from '../common/errors/api.exception.js';

export interface PurchaseResponse {
  purchaseId: string;
  productId: string;
  quantity: number;
  unitPrice: string;
  totalAmount: string;
  currency: string;
  paymentMethod: string;
  createdAt: string;
}

@Injectable()
export class PurchaseService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the user's most recent flash-sale purchase. For this assessment
   * GET /purchases/:userId is documented as returning the flash-sale purchase
   * when present; regular product purchases are intentionally out of scope
   * for this lookup.
   *
   * `userId` is an explicit path parameter for this assessment; production
   * authorization would restrict callers to their own purchase data.
   */
  async getPurchaseForUser(userId: string): Promise<PurchaseResponse> {
    const purchase = await this.prisma.purchase.findFirst({
      where: { userId, isFlashSale: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!purchase) throw ApiException.purchaseNotFound();
    return this.toResponse(purchase);
  }

  private toResponse(purchase: Purchase): PurchaseResponse {
    return {
      purchaseId: purchase.id,
      productId: purchase.productId,
      quantity: purchase.quantity,
      unitPrice: purchase.unitPrice.toFixed(2),
      totalAmount: purchase.totalAmount.toFixed(2),
      currency: purchase.currency,
      paymentMethod: purchase.paymentMethod,
      createdAt: purchase.createdAt.toISOString(),
    };
  }
}
