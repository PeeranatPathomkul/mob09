import { Controller, Get, Query } from '@nestjs/common';
import { ListProductsQueryDto } from '../cache/dto/list-products-query.dto';
import {
  ProductCacheService,
  ProductsPageResponse,
} from '../cache/product-cache.service';

@Controller('api/v1/products')
export class ProductsController {
  constructor(private readonly productCacheService: ProductCacheService) {}

  @Get()
  findAll(@Query() query: ListProductsQueryDto): Promise<ProductsPageResponse> {
    return this.productCacheService.getProductsPage(query.page, query.limit);
  }
}
