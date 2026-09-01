import { Injectable } from '@nestjs/common';
import { CheckoutStatus, Prisma, type Purchase } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { Clock } from '../common/clock.js';
import { ApiException } from '../common/errors/api.exception.js';
import { SaleService } from '../sale/sale.service.js';
import { CreateTransactionDto } from './dto/create-transaction.dto.js';

export interface TransactionResponse {
  purchaseId: string;
  requestId: string;
  status: 'COMPLETED';
  productId: string;
  quantity: number;
  unitPrice: string;
  totalAmount: string;
  currency: string;
  paymentMethod: string;
  createdAt: string;
}

type TxOutcome =
  { ok: true; purchase: Purchase } | { ok: false; error: ApiException };

/**
 * Executes the final purchase operation.
 *
 * Concurrency strategy (all enforced by PostgreSQL, never Redis/memory):
 *
 *   1. requestId ownership verified before any state change.
 *   2. PENDING → PROCESSING is an atomic conditional UPDATE; exactly one
 *      concurrent caller can claim a checkout.
 *   3. Every flash-sale condition is revalidated inside the transaction —
 *      checkout-time validation is only an optimization.
 *   4. Stock is decremented with an atomic conditional UPDATE
 *      (`WHERE remaining_stock > 0`), so overselling is impossible.
 *   5. UNIQUE(user_id) on purchases is the final one-per-user guard; a
 *      violation rolls the whole transaction back, restoring the stock.
 *
 * Terminal, non-retryable outcomes (sold out, already purchased, sale no
 * longer valid) mark the checkout FAILED/EXPIRED and COMMIT, so the
 * requestId becomes permanently unusable. Unexpected errors ROLL BACK,
 * returning the checkout to PENDING so it never gets stuck in PROCESSING.
 */
@Injectable()
export class TransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly saleService: SaleService,
    private readonly clock: Clock,
  ) {}

  async execute(dto: CreateTransactionDto): Promise<TransactionResponse> {
    let outcome: TxOutcome;
    try {
      outcome = await this.prisma.$transaction(
        (tx) => this.runInTransaction(tx, dto),
        // Headroom for lock waits when many requests race the same rows.
        { timeout: 10_000 },
      );
    } catch (error) {
      throw this.translateTransactionError(error);
    }

    if (!outcome.ok) throw outcome.error;
    return this.toResponse(outcome.purchase);
  }

  private async runInTransaction(
    tx: Prisma.TransactionClient,
    dto: CreateTransactionDto,
  ): Promise<TxOutcome> {
    // 1. Locate + ownership. Nothing has been mutated yet, so throwing here
    //    is a clean no-op rollback.
    const checkout = await tx.checkout.findUnique({
      where: { requestId: dto.requestId },
    });
    if (!checkout) throw ApiException.checkoutNotFound();
    if (checkout.userId !== dto.userId)
      throw ApiException.requestNotAuthorized();

    // 2. Atomic claim. The conditional UPDATE takes a row lock; concurrent
    //    claims on the same requestId serialize and exactly one succeeds.
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      UPDATE checkouts
      SET status = 'PROCESSING'::"CheckoutStatus", updated_at = NOW()
      WHERE request_id = ${dto.requestId}
        AND status = 'PENDING'::"CheckoutStatus"
      RETURNING id`;
    if (claimed.length === 0) {
      // Re-read: the status read before the claim may be stale (the row lock
      // serializes concurrent claims, so by the time the claim fails the
      // holder has usually committed its terminal state).
      const current = await tx.checkout.findUniqueOrThrow({
        where: { requestId: dto.requestId },
      });
      throw this.mapClaimConflict(current.status);
    }

    // From here on, any non-retryable failure must be recorded on the
    // checkout (FAILED/EXPIRED) and committed, so the requestId cannot be
    // retried. Truly unexpected errors still roll back to PENDING.

    // 3. Revalidate everything at transaction time.
    if (this.clock.now() >= checkout.expiresAt) {
      await this.markStatus(tx, checkout.id, CheckoutStatus.EXPIRED);
      return { ok: false, error: ApiException.checkoutExpired() };
    }

    let flashSale: { id: string } | null = null;
    try {
      const result = await this.saleService.assertPurchasable(
        checkout.productId,
        tx,
      );
      flashSale = result.flashSale;
    } catch (error) {
      if (error instanceof ApiException) {
        await this.markStatus(tx, checkout.id, CheckoutStatus.FAILED);
        return { ok: false, error };
      }
      throw error;
    }

    // Quantity rule depends on product type: flash-sale products are limited
    // to exactly one unit; regular products must simply order a positive quantity.
    if (flashSale && checkout.quantity !== 1) {
      await this.markStatus(tx, checkout.id, CheckoutStatus.FAILED);
      return { ok: false, error: ApiException.invalidQuantity() };
    }
    if (!flashSale && checkout.quantity <= 0) {
      await this.markStatus(tx, checkout.id, CheckoutStatus.FAILED);
      return { ok: false, error: ApiException.invalidQuantity() };
    }

    if (flashSale) {
      const existingPurchase = await tx.purchase.findFirst({
        where: { userId: dto.userId, isFlashSale: true },
        select: { id: true },
      });
      if (existingPurchase) {
        await this.markStatus(tx, checkout.id, CheckoutStatus.FAILED);
        return { ok: false, error: ApiException.alreadyPurchased() };
      }
    }


    // 4. Atomic inventory decrement — the only place stock is consumed.
    const decremented = await tx.$queryRaw<{ id: string }[]>`
      UPDATE products
      SET remaining_stock = remaining_stock - ${checkout.quantity}, updated_at = NOW()
      WHERE id = ${checkout.productId}::uuid
        AND remaining_stock > 0
      RETURNING id`;
    if (decremented.length === 0) {
      await this.markStatus(tx, checkout.id, CheckoutStatus.FAILED);
      return { ok: false, error: ApiException.soldOut() };
    }

    // 5. Create the purchase from the checkout's price snapshot. A
    //    flash-sale partial unique index violation under concurrency poisons
    //    this statement and must roll the whole transaction back (restoring
    //    the stock), so it is intentionally NOT caught here — see
    //    translateTransactionError.
    const totalAmount = new Prisma.Decimal(checkout.unitPrice).mul(
      checkout.quantity,
    );
    const purchase = await tx.purchase.create({
      data: {
        userId: checkout.userId,
        productId: checkout.productId,
        requestId: checkout.requestId,
        quantity: checkout.quantity,
        isFlashSale: !!flashSale,
        unitPrice: checkout.unitPrice,
        totalAmount,
        currency: checkout.currency,
        paymentMethod: checkout.paymentMethod,
      },
    });

    await this.markStatus(tx, checkout.id, CheckoutStatus.COMPLETED);
    return { ok: true, purchase };
  }

  /** Checkout state after a failed claim, mapped to the contract codes. */
  private mapClaimConflict(status: CheckoutStatus): ApiException {
    switch (status) {
      case CheckoutStatus.PROCESSING:
        return ApiException.transactionProcessing();
      case CheckoutStatus.EXPIRED:
      case CheckoutStatus.CANCELLED:
        return ApiException.checkoutExpired();
      default:
        // COMPLETED / FAILED — requestId is permanently spent.
        return ApiException.requestAlreadyProcessed();
    }
  }

  /**
   * Maps errors that escaped the transaction callback. P2002 means a unique
   * constraint (user_id or request_id) was violated by a concurrent request;
   * the transaction has already rolled back, so stock is intact.
   */
  private translateTransactionError(error: unknown): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const target = (error.meta?.target as string[] | undefined) ?? [];
      if (target.includes('user_id')) return ApiException.alreadyPurchased();
      return ApiException.requestAlreadyProcessed();
    }
    return error;
  }

  private async markStatus(
    tx: Prisma.TransactionClient,
    checkoutId: string,
    status: CheckoutStatus,
  ): Promise<void> {
    await tx.checkout.update({ where: { id: checkoutId }, data: { status } });
  }

  private toResponse(purchase: Purchase): TransactionResponse {
    return {
      purchaseId: purchase.id,
      requestId: purchase.requestId,
      status: 'COMPLETED',
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
