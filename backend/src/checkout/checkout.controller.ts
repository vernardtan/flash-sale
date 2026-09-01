import { Body, Controller, Post } from '@nestjs/common';
import { RateLimit } from '../common/rate-limit/rate-limit.guard.js';
import { CheckoutService, CheckoutResponse } from './checkout.service.js';
import { CreateCheckoutDto } from './dto/create-checkout.dto.js';

@Controller('checkouts')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post()
  @RateLimit('checkout')
  create(@Body() dto: CreateCheckoutDto): Promise<CheckoutResponse> {
    return this.checkoutService.createCheckout(dto);
  }
}
