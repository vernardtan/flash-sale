import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ApiExceptionFilter } from './errors/api-exception.filter.js';
import { RateLimitGuard } from './rate-limit/rate-limit.guard.js';
import { Clock } from './clock.js';

// Genuinely shared infrastructure only (global filters/guards, Clock).
@Global()
@Module({
  providers: [
    Clock,
    {
      provide: APP_FILTER,
      useClass: ApiExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
  ],
  exports: [Clock],
})
export class CommonModule {}
