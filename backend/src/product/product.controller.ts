import { Controller, Get, Query } from '@nestjs/common';
import { ProductService, ProductResponse } from './product.service.js';

@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  /**
   * @param userId Development-only identity hint used to compute per-user
   *   eligibility. Production would derive the user from an authenticated
   *   principal instead of a query parameter.
   */
  @Get()
  list(
    @Query('userId') userId?: string,
  ): Promise<{ products: ProductResponse[] }> {
    return this.productService.listProducts(userId);
  }
}
