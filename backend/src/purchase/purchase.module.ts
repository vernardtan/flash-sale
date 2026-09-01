import { Module } from '@nestjs/common';
import { SaleModule } from '../sale/sale.module.js';
import { PurchaseController } from './purchase.controller.js';
import { PurchaseService } from './purchase.service.js';
import { TransactionController } from './transaction.controller.js';
import { TransactionService } from './transaction.service.js';

@Module({
  imports: [SaleModule],
  controllers: [PurchaseController, TransactionController],
  providers: [PurchaseService, TransactionService],
})
export class PurchaseModule {}
