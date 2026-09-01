import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../common/clock.js';
import { randomUUID } from 'node:crypto';
import { ApiException } from '../common/errors/api.exception.js';
import type { FlashSale, Prisma, Product } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { SaleService } from '../sale/sale.service.js';
import { isValidPaymentMethod } from '../payment/payment-methods.js';
import { CreateCheckoutDto } from './dto/create-checkout.dto.js';
import { CheckoutResponse } from './dto/checkout-response.dto.js';

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
   * The requestId is generated here and
   * acts as the idempotency handle for the subsequent transaction.
   */
  async createCheckout(dto: CreateCheckoutDto): Promise<CheckoutResponse> {
    const { product, flashSale } = await this.saleService.assertPurchasable(
      dto.productId);
    await this.validate(dto, flashSale);
    const checkout = await this.saveCheckout(dto, product);

    return {
      requestId: checkout.requestId,
      checkoutId: checkout.id,
      status: 'PENDING',
      productId: checkout.productId,
      quantity: checkout.quantity,
      unitPrice: checkout.unitPrice.toFixed(2),
      currency: checkout.currency,
      expiresAt: checkout.expiresAt.toISOString()
    };
  }
  
  async validate(dto: CreateCheckoutDto, flashSale: FlashSale) {
    
    if (!isValidPaymentMethod(dto.paymentMethod)) {
      throw ApiException.invalidPaymentMethod();
    }
    if (!flashSale && dto.quantity <= 0) {
      throw ApiException.invalidQuantity();
    }

    if (flashSale) {
      if (dto.quantity !== 1) throw ApiException.invalidQuantity(
        'Quantity must be exactly 1 for the flash-sale product.'
      );

      const existingPurchase = await this.prisma.purchase.findFirst({
        where: { userId: dto.userId, isFlashSale: true },
        select: { id: true },
      });
      if (existingPurchase) throw ApiException.alreadyPurchased();
    }
  }

  async saveCheckout(dto: CreateCheckoutDto, product: Product) {
    const expirationSeconds = this.config.get<number>(
      'CHECKOUT_EXPIRATION_SECONDS',
      900,
    );
    const expiresAt = new Date(
      this.clock.now().getTime() + expirationSeconds * 1000,
    );

    return await this.prisma.checkout.create({
      data: {
        requestId: randomUUID(),
        userId: dto.userId,
        productId: product.id,
        quantity: dto.quantity,
        unitPrice: product.price,
        currency: product.currency,
        paymentMethod: dto.paymentMethod,
        expiresAt
      }
    });
  }
}
