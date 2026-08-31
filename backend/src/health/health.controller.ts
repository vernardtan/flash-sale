import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  dependencies: {
    database: 'up' | 'down';
    redis: 'up' | 'down';
  };
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly database: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const [databaseUp, redisUp] = await Promise.all([
      this.database.ping().then(
        () => true,
        () => false,
      ),
      this.redis.ping().then(
        () => true,
        () => false,
      ),
    ]);

    const response: HealthResponse = {
      status: databaseUp && redisUp ? 'ok' : 'degraded',
      dependencies: {
        database: databaseUp ? 'up' : 'down',
        redis: redisUp ? 'up' : 'down',
      },
    };

    if (response.status === 'degraded') {
      throw new ServiceUnavailableException(response);
    }
    return response;
  }
}
