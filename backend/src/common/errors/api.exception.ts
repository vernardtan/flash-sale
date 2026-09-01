import { HttpException, HttpStatus } from '@nestjs/common';
import { ApiErrorCode } from './api-error-code.enum.js';

/**
 * Domain error carrying a stable machine-readable `code`.
 * Thrown by services/controllers; serialized by ApiExceptionFilter.
 */
export class ApiException extends HttpException {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    status: HttpStatus,
  ) {
    super({ code, message }, status);
  }

  // ── Sale / product ──────────────────────────────────────────────
  static saleDisabled(): ApiException {
    return new ApiException(
      ApiErrorCode.SALE_DISABLED,
      'The flash sale is currently disabled.',
      HttpStatus.CONFLICT,
    );
  }

  static saleUpcoming(): ApiException {
    return new ApiException(
      ApiErrorCode.SALE_UPCOMING,
      'The flash sale has not started yet.',
      HttpStatus.CONFLICT,
    );
  }

  static saleEnded(): ApiException {
    return new ApiException(
      ApiErrorCode.SALE_ENDED,
      'The flash sale has ended.',
      HttpStatus.CONFLICT,
    );
  }

  static soldOut(): ApiException {
    return new ApiException(
      ApiErrorCode.SOLD_OUT,
      'This product is sold out.',
      HttpStatus.CONFLICT,
    );
  }

  static productDisabled(): ApiException {
    return new ApiException(
      ApiErrorCode.PRODUCT_DISABLED,
      'This product is not available.',
      HttpStatus.CONFLICT,
    );
  }

  static productNotFound(): ApiException {
    return new ApiException(
      ApiErrorCode.PRODUCT_NOT_FOUND,
      'Product not found.',
      HttpStatus.NOT_FOUND,
    );
  }

  // ── Purchases ───────────────────────────────────────────────────
  static alreadyPurchased(): ApiException {
    return new ApiException(
      ApiErrorCode.ALREADY_PURCHASED,
      'You have already purchased this item.',
      HttpStatus.CONFLICT,
    );
  }

  static purchaseNotFound(): ApiException {
    return new ApiException(
      ApiErrorCode.PURCHASE_NOT_FOUND,
      'No purchase found for this user.',
      HttpStatus.NOT_FOUND,
    );
  }

  // ── Checkout / request lifecycle ────────────────────────────────
  static checkoutNotFound(): ApiException {
    return new ApiException(
      ApiErrorCode.CHECKOUT_NOT_FOUND,
      'Checkout request not found.',
      HttpStatus.NOT_FOUND,
    );
  }

  static checkoutExpired(): ApiException {
    return new ApiException(
      ApiErrorCode.CHECKOUT_EXPIRED,
      'This checkout has expired. Please start a new checkout.',
      HttpStatus.GONE,
    );
  }

  static requestNotAuthorized(): ApiException {
    return new ApiException(
      ApiErrorCode.REQUEST_NOT_AUTHORIZED,
      'You are not authorized to use this request.',
      HttpStatus.FORBIDDEN,
    );
  }

  static transactionProcessing(): ApiException {
    return new ApiException(
      ApiErrorCode.TRANSACTION_PROCESSING,
      'This request is already being processed.',
      HttpStatus.CONFLICT,
    );
  }

  static requestAlreadyProcessed(): ApiException {
    return new ApiException(
      ApiErrorCode.REQUEST_ALREADY_PROCESSED,
      'This request has already been processed.',
      HttpStatus.CONFLICT,
    );
  }

  // ── Input validation ────────────────────────────────────────────
  static invalidQuantity(
    message = 'Quantity must be greater than 0.',
  ): ApiException {
    return new ApiException(
      ApiErrorCode.INVALID_QUANTITY,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }

  static invalidPaymentMethod(): ApiException {
    return new ApiException(
      ApiErrorCode.INVALID_PAYMENT_METHOD,
      'Unsupported payment method.',
      HttpStatus.BAD_REQUEST,
    );
  }

  // ── Infrastructure ──────────────────────────────────────────────
  static rateLimited(): ApiException {
    return new ApiException(
      ApiErrorCode.RATE_LIMITED,
      'Too many requests. Please try again shortly.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
