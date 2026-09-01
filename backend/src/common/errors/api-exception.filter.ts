import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiErrorCode } from './api-error-code.enum.js';
import { ApiException } from './api.exception.js';

interface ErrorBody {
  code: ApiErrorCode;
  message: string;
}

/**
 * Global error serializer. Guarantees every error response has the shape
 * `{ code, message }` and that raw Prisma/PostgreSQL/Nest internals never
 * reach the client.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    const { status, body } = this.toErrorBody(exception);
    response.status(status).json(body);
  }

  private toErrorBody(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof ApiException) {
      return {
        status: exception.getStatus(),
        body: { code: exception.code, message: exception.message },
      };
    }

    // ValidationPipe failures surface as BadRequestException with an array of
    // messages; fold them into one client-safe string.
    if (exception instanceof BadRequestException) {
      const response = exception.getResponse();
      const messages =
        typeof response === 'object' &&
        response !== null &&
        'message' in response
          ? (response as { message: string | string[] }).message
          : exception.message;
      return {
        status: exception.getStatus(),
        body: {
          code: ApiErrorCode.VALIDATION_FAILED,
          message: Array.isArray(messages) ? messages.join('; ') : messages,
        },
      };
    }

    if (exception instanceof HttpException) {
      // Framework-level errors (404 routes, 429, etc.) — keep the status and
      // a safe message, but normalize the shape.
      return {
        status: exception.getStatus(),
        body: {
          code: ApiErrorCode.INTERNAL_ERROR,
          message: exception.message,
        },
      };
    }

    // Unknown/unexpected (including Prisma errors): log server-side, return a
    // generic body. Never leak internals.
    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: ApiErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred.',
      },
    };
  }
}
