import { Module } from '@nestjs/common';
import { PaymentMethodsController } from './payment-methods.controller.js';

@Module({
  controllers: [PaymentMethodsController],
})
export class PaymentModule {}
