import { Controller, Get, Param } from '@nestjs/common';
import { PurchaseService, PurchaseResponse } from './purchase.service.js';

@Controller('purchases')
export class PurchaseController {
  constructor(private readonly purchaseService: PurchaseService) {}

  @Get(':userId')
  getForUser(@Param('userId') userId: string): Promise<PurchaseResponse> {
    return this.purchaseService.getPurchaseForUser(userId);
  }
}
