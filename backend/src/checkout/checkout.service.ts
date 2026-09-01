import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { Clock } from '../common/clock.js';
import { ApiException } from '../common/errors/api.exception.js';
import { SaleService } from '../sale/sale.service.js';
import { isValidPaymentMethod } from '../payment/payment-methods.js';
import { CreateCheckoutDto } from './dto/create-checkout.dto.js';

export interface CheckoutResponse {
  requestId: string;
  checkoutId: string;
  status: 'PENDING';
  productId: string;
  quantity: number;
  unitPrice: string;
  currency: string;
  expiresAt: string;
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly saleService: SaleService,
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {}

  /**
   * Starts a checkout. Deliberately does NOT decrement or reserve stock —
   * inventory is consumed only by the final transaction.
   *
   * The requestId is generated here (never accepted from the client) and
   * acts as the idempotency handle for the subsequent transaction.
   */
  async createCheckout(dto: CreateCheckoutDto): Promise<CheckoutResponse> {
    if (!isValidPaymentMethod(dto.paymentMethod)) {
      throw ApiException.invalidPaymentMethod();
    }

    const { product, flashSale } =
      await this.saleService.assertPurchasable(dto.productId);


    if (flashSale) {
      // Flash-sale products are strictly limited to one unit per checkout.
      // Regular products must simply order a positive quantity.
      if (dto.quantity !== 1) throw ApiException.invalidQuantity(
        'Quantity must be exactly 1 for the flash-sale product.',
      );

      const existingPurchase = await this.prisma.purchase.findFirst({
        where: { userId: dto.userId, isFlashSale: true },
        select: { id: true },
      });
      if (existingPurchase) throw ApiException.alreadyPurchased();
    }

    if (!flashSale && dto.quantity <= 0) {
      throw ApiException.invalidQuantity('Quantity must be greater than 0.');
    }

    const expirationSeconds = this.config.get<number>(
      'CHECKOUT_EXPIRATION_SECONDS',
      900,
    );
    const expiresAt = new Date(
      this.clock.now().getTime() + expirationSeconds * 1000,
    );

    const checkout = await this.prisma.checkout.create({
      data: {
        requestId: randomUUID(),
        userId: dto.userId,
        productId: product.id,
        quantity: dto.quantity,
        // Price snapshot: later product price changes must not alter this
        // checkout or the resulting order.
        unitPrice: product.price,
        currency: product.currency,
        paymentMethod: dto.paymentMethod,
        expiresAt,
      },
    });

    return {
      requestId: checkout.requestId,
      checkoutId: checkout.id,
      status: 'PENDING',
      productId: checkout.productId,
      quantity: checkout.quantity,
      unitPrice: checkout.unitPrice.toFixed(2),
      currency: checkout.currency,
      expiresAt: checkout.expiresAt.toISOString(),
    };
  }
}
