import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/**
 * Thin abstraction over the Redis client.
 *
 * Redis is supporting infrastructure only (rate limiting, optional caching).
 * It is never the source of truth for inventory or purchases — PostgreSQL
 * guarantees business correctness.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private errorLogged = false;
  private shuttingDown = false;

  constructor(config: ConfigService) {
    this.client = new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: (times: number) =>
        this.shuttingDown ? null : Math.min(times * 200, 2000),
    });

    this.client.on('error', (error: Error) => {
      // Rate-limit reconnect noise: log the first error, then only on recovery.
      if (!this.errorLogged) {
        this.logger.error(`Redis error: ${error.message}`);
        this.errorLogged = true;
      }
    });
    this.client.on('ready', () => {
      if (this.errorLogged) {
        this.logger.log('Redis connection recovered');
        this.errorLogged = false;
      }
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      await this.ping();
      this.logger.log('Redis connection established');
    } catch (error) {
      this.logger.error(
        'Redis connection failed at startup',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    this.client.disconnect();
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  getClient(): Redis {
    return this.client;
  }
}
