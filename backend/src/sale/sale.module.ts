import { Module } from '@nestjs/common';
import { SaleController } from './sale.controller.js';
import { SaleService } from './sale.service.js';

@Module({
  controllers: [SaleController],
  providers: [SaleService],
  exports: [SaleService],
})
export class SaleModule {}
