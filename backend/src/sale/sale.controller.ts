import { Controller, Get } from '@nestjs/common';
import { SaleService, SaleStatusResponse } from './sale.service.js';

@Controller('sale')
export class SaleController {
  constructor(private readonly saleService: SaleService) {}

  @Get('status')
  getStatus(): Promise<SaleStatusResponse> {
    return this.saleService.getStatus();
  }
}
