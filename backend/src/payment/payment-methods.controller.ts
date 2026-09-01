import { Controller, Get } from '@nestjs/common';
import { PAYMENT_METHODS, PaymentMethod } from './payment-methods.js';

@Controller('payment-methods')
export class PaymentMethodsController {
  @Get()
  list(): { paymentMethods: PaymentMethod[] } {
    return { paymentMethods: [...PAYMENT_METHODS] };
  }
}
