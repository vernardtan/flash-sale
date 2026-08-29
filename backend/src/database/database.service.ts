import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResult, QueryResultRow } from 'pg';

/**
 * Thin wrapper around a pg connection pool.
 *
 * Phase 2 uses this for connectivity/health verification.
 * Prisma becomes the primary data access layer in Phase 3; this pool
 * remains useful for liveness checks and raw administrative queries.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      host: config.get<string>('DATABASE_HOST', 'localhost'),
      port: config.get<number>('DATABASE_PORT', 5432),
      database: config.get<string>('DATABASE_NAME', 'flash_sale'),
      user: config.get<string>('DATABASE_USER', 'flash_sale'),
      password: config.get<string>('DATABASE_PASSWORD', 'flash_sale_dev'),
      max: 10,
      connectionTimeoutMillis: 5000,
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.ping();
      this.logger.log('PostgreSQL connection established');
    } catch (error) {
      // Do not crash on startup: the health endpoint reports the outage
      // and the pool will keep retrying per-connection.
      this.logger.error(
        'PostgreSQL connection failed at startup',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }
}
