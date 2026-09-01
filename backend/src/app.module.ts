import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module.js';
import { RedisModule } from './redis/redis.module.js';
import { HealthModule } from './health/health.module.js';
import { SaleModule } from './sale/sale.module.js';
import { ProductModule } from './product/product.module.js';
import { PurchaseModule } from './purchase/purchase.module.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import { PaymentModule } from './payment/payment.module.js';
import { CommonModule } from './common/common.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Local dev: backend/.env overrides, then repo-root .env.
      // In Docker, variables are injected by compose and env files are absent.
      envFilePath: ['.env', '../.env'],
    }),
    DatabaseModule,
    RedisModule,
    HealthModule,
    SaleModule,
    ProductModule,
    CheckoutModule,
    PurchaseModule,
    PaymentModule,
    CommonModule,
  ],
})
export class AppModule {}
