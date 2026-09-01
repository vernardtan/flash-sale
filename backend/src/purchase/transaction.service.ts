import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 *   2. PENDING → PROCESSING is claimed in a separate, committed conditional
 *      UPDATE so the PROCESSING state is durably visible before the purchase
 *      transaction begins. Concurrent callers immediately observe
 *      TRANSACTION_PROCESSING instead of blocking on a row lock.
 *   3. Every flash-sale condition is revalidated inside the purchase
 *      transaction — checkout-time validation is only an optimization.
 *   4. Stock is decremented with an atomic conditional UPDATE
 *      (`WHERE remaining_stock >= $quantity`), so overselling is impossible
 *      for both flash-sale (quantity = 1) and regular (quantity > 0) products.
 *   5. Partial unique index `purchases(user_id) WHERE is_flash_sale = true`
 *      is the final one-per-user guard; a violation rolls the whole purchase
 *      transaction back, restoring the stock.
 *
 * Terminal, non-retryable outcomes (sold out, already purchased, sale no
 * longer valid) mark the checkout FAILED/EXPIRED and COMMIT, so the
 * requestId becomes permanently unusable. Unexpected errors ROLL BACK the
 * purchase transaction; a best-effort follow-up then marks the checkout
 * FAILED so PROCESSING can never strand forever.
 */
@Injectable()
export class TransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly saleService: SaleService,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  async execute(dto: CreateTransactionDto): Promise<TransactionResponse> {
    const checkout = await this.prisma.checkout.findUnique({
      where: { requestId: dto.requestId },
    });
    if (!checkout) throw ApiException.checkoutNotFound();
    if (checkout.userId !== dto.userId)
      throw ApiException.requestNotAuthorized();

    const claimed = await this.tryClaimCheckout(dto.requestId);
    if (!claimed) {
      // Race loser or already non-PENDING. Re-read the durable state and map.
      const current = await this.prisma.checkout.findUniqueOrThrow({
        where: { requestId: dto.requestId },
      });
      throw await this.mapNonPendingStatus(current);
    }

    // Test-only hook: allow tests to observe the committed PROCESSING state
    // before the purchase transaction begins. Production default is 0.
    const processingDelayMs = Number(
      this.config.get('CHECKOUT_PROCESSING_DELAY_MS') ?? '0',
    );
    if (processingDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, processingDelayMs));
    }

    let outcome: TxOutcome;
    try {
      outcome = await this.prisma.$transaction(
        (tx) => this.runPurchase(tx, checkout, dto),
        // Headroom for lock waits when many requests race the same rows.
        { timeout: 10_000 },
      );
    } catch (error) {
      // The purchase transaction rolled back (stock restored, no purchase).
      // Best-effort mark the checkout FAILED so the requestId is spent and
      // cannot get stuck in PROCESSING.
      await this.markFailed(checkout.id);
      throw this.translateTransactionError(error);
    }

    if (!outcome.ok) {
      // Business-deterministic failure already committed inside the
      // purchase transaction. No need to translate or mark status.
      throw outcome.error;
    }
    return this.toResponse(outcome.purchase);
  }

  /**
   * Atomically claims a PENDING checkout into PROCESSING. Runs as a single
   * autocommit conditional UPDATE so the state change is durably visible
   * immediately, before the purchase transaction starts.
   */
  private async tryClaimCheckout(requestId: string): Promise<boolean> {
    const result = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE checkouts
      SET status = 'PROCESSING'::"CheckoutStatus", updated_at = NOW()
      WHERE request_id = ${requestId}
        AND status = 'PENDING'::"CheckoutStatus"
      RETURNING id`;
    return result.length > 0;
  }

  /**
   * Maps a checkout that is not PENDING at claim time. Handles fresh vs stale
   * PROCESSING and all terminal states.
   */
  private async mapNonPendingStatus(checkout: {
    id: string;
    status: CheckoutStatus;
    updatedAt: Date;
  }): Promise<ApiException> {
    switch (checkout.status) {
      case CheckoutStatus.PROCESSING:
        if (this.isProcessingStale(checkout.updatedAt)) {
          await this.recoverStaleProcessing(checkout.id);
          return ApiException.requestAlreadyProcessed();
        }
        return ApiException.transactionProcessing();
      case CheckoutStatus.EXPIRED:
      case CheckoutStatus.CANCELLED:
        return ApiException.checkoutExpired();
      default:
        // COMPLETED / FAILED — requestId is permanently spent.
        return ApiException.requestAlreadyProcessed();
    }
  }

  private isProcessingStale(updatedAt: Date): boolean {
    const timeoutSeconds = this.config.get<number>(
      'CHECKOUT_PROCESSING_TIMEOUT_SECONDS',
      300,
    );
    const threshold = new Date(
      this.clock.now().getTime() - timeoutSeconds * 1000,
    );
    return updatedAt < threshold;
  }

  /**
   * Lazily recovers a stale PROCESSING checkout to FAILED. The requestId is
   * intentionally spent rather than retried: the original purchase phase may
   * still be alive somewhere, so we never risk executing it twice.
   */
  private async recoverStaleProcessing(checkoutId: string): Promise<void> {
    const timeoutSeconds = this.config.get<number>(
      'CHECKOUT_PROCESSING_TIMEOUT_SECONDS',
      300,
    );
    await this.prisma.$executeRaw`
      UPDATE checkouts
      SET status = 'FAILED'::"CheckoutStatus", updated_at = NOW()
      WHERE id = ${checkoutId}::uuid
        AND status = 'PROCESSING'::"CheckoutStatus"
        AND updated_at < NOW() - INTERVAL '${Prisma.raw(
          `${timeoutSeconds} seconds`,
        )}'`;
  }

  /**
   * Best-effort terminal transition to FAILED after an unexpected rollback.
   * Guarded by status='PROCESSING' so it can never clobber COMPLETED.
   */
  private async markFailed(checkoutId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE checkouts
        SET status = 'FAILED'::"CheckoutStatus", updated_at = NOW()
        WHERE id = ${checkoutId}::uuid
          AND status = 'PROCESSING'::"CheckoutStatus"`;
    } catch {
      // Swallow: the caller already has the original error and the checkout
      // may remain PROCESSING until the next access triggers lazy recovery.
    }
  }

  private async runPurchase(
    tx: Prisma.TransactionClient,
    checkout: {
      id: string;
      userId: string;
      productId: string;
      quantity: number;
      unitPrice: Prisma.Decimal;
      currency: string;
      paymentMethod: string;
      requestId: string;
      expiresAt: Date;
    },
    dto: CreateTransactionDto,
  ): Promise<TxOutcome> {
    // 1. Expiry is checked again inside the purchase transaction because the
    //    claim committed some time ago.
    if (this.clock.now() >= checkout.expiresAt) {
      await this.markStatus(
        tx,
        checkout.id,
        CheckoutStatus.EXPIRED,
        CheckoutStatus.PROCESSING,
      );
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
        await this.markStatus(
          tx,
          checkout.id,
          CheckoutStatus.FAILED,
          CheckoutStatus.PROCESSING,
        );
        return { ok: false, error };
      }
      throw error;
    }

    // Quantity rule depends on product type: flash-sale products are limited
    // to exactly one unit; regular products must simply order a positive quantity.
    if (flashSale && checkout.quantity !== 1) {
      await this.markStatus(
        tx,
        checkout.id,
        CheckoutStatus.FAILED,
        CheckoutStatus.PROCESSING,
      );
      return { ok: false, error: ApiException.invalidQuantity() };
    }
    if (!flashSale && checkout.quantity <= 0) {
      await this.markStatus(
        tx,
        checkout.id,
        CheckoutStatus.FAILED,
        CheckoutStatus.PROCESSING,
      );
      return { ok: false, error: ApiException.invalidQuantity() };
    }

    if (flashSale) {
      const existingPurchase = await tx.purchase.findFirst({
        where: { userId: dto.userId, isFlashSale: true },
        select: { id: true },
      });
      if (existingPurchase) {
        await this.markStatus(
          tx,
          checkout.id,
          CheckoutStatus.FAILED,
          CheckoutStatus.PROCESSING,
        );
        return { ok: false, error: ApiException.alreadyPurchased() };
      }
    }

    // 2. Atomic inventory decrement — the only place stock is consumed.
    const decremented = await tx.$queryRaw<{ id: string }[]>`
      UPDATE products
      SET remaining_stock = remaining_stock - ${checkout.quantity}, updated_at = NOW()
      WHERE id = ${checkout.productId}::uuid
        AND remaining_stock >= ${checkout.quantity}
      RETURNING id`;
    if (decremented.length === 0) {
      await this.markStatus(
        tx,
        checkout.id,
        CheckoutStatus.FAILED,
        CheckoutStatus.PROCESSING,
      );
      return { ok: false, error: ApiException.soldOut() };
    }

    // 3. Create the purchase from the checkout's price snapshot. A
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

    await this.markStatus(
      tx,
      checkout.id,
      CheckoutStatus.COMPLETED,
      CheckoutStatus.PROCESSING,
    );
    return { ok: true, purchase };
  }

  /**
   * Maps errors that escaped the purchase transaction callback. P2002 means a
   * unique constraint (user_id or request_id) was violated by a concurrent
   * request; the transaction has already rolled back, so stock is intact.
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
    expectedStatus: CheckoutStatus,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE checkouts
      SET status = ${status}::"CheckoutStatus", updated_at = NOW()
      WHERE id = ${checkoutId}::uuid
        AND status = ${expectedStatus}::"CheckoutStatus"`;
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
