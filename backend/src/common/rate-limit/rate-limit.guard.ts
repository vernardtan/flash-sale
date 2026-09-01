import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RedisService } from '../../redis/redis.service.js';
import { ApiException } from '../errors/api.exception.js';

export type RateLimitBucket = 'checkout' | 'transaction';

export const RATE_LIMIT_BUCKET = 'rateLimitBucket';

/** Apply to a handler to enable Redis-backed rate limiting for it. */
export const RateLimit = (bucket: RateLimitBucket): MethodDecorator =>
  SetMetadata(RATE_LIMIT_BUCKET, bucket);

const BUCKET_CONFIG: Record<
  RateLimitBucket,
  { maxEnv: string; defaultMax: number }
> = {
  checkout: { maxEnv: 'RATE_LIMIT_CHECKOUT_MAX', defaultMax: 10 },
  transaction: { maxEnv: 'RATE_LIMIT_TRANSACTION_MAX', defaultMax: 20 },
};

/**
 * Fixed-window per-client rate limiter backed by Redis.
 *
 * Redis is protective infrastructure only — never correctness. If Redis is
 * unavailable the guard FAILS OPEN (logs a warning, allows the request):
 * inventory and one-per-user guarantees are enforced by PostgreSQL, so a
 * Redis outage degrades protection, not correctness.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const bucket = this.reflector.getAllAndOverride<RateLimitBucket>(
      RATE_LIMIT_BUCKET,
      [context.getHandler(), context.getClass()],
    );
    if (!bucket) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const identity = this.clientIdentity(request);
    const windowSeconds = this.config.get<number>(
      'RATE_LIMIT_WINDOW_SECONDS',
      60,
    );
    const { maxEnv, defaultMax } = BUCKET_CONFIG[bucket];
    const max = this.config.get<number>(maxEnv, defaultMax);
    const key = `rl:${bucket}:${identity}`;

    try {
      const client = this.redis.getClient();
      const count = await client.incr(key);
      if (count === 1) {
        await client.expire(key, windowSeconds);
      }
      if (count > max) throw ApiException.rateLimited();
      return true;
    } catch (error) {
      if (error instanceof ApiException) throw error;
      this.logger.warn(
        `Rate limiter unavailable (Redis): ${error instanceof Error ? error.message : String(error)} — allowing request`,
      );
      return true;
    }
  }

  private clientIdentity(request: Request): string {
    const body = request.body as Record<string, unknown> | undefined;
    const userId = typeof body?.userId === 'string' ? body.userId : null;
    return userId ?? request.ip ?? 'anonymous';
  }
}
