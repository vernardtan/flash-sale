import { Module } from '@nestjs/common';
import { SaleModule } from '../sale/sale.module.js';
import { ProductController } from './product.controller.js';
import { ProductService } from './product.service.js';

@Module({
  imports: [SaleModule],
  controllers: [ProductController],
  providers: [ProductService],
})
export class ProductModule {}
