import { Controller, Get } from '@nestjs/common';
import { CacheStats, ProductCacheService } from './product-cache.service';

@Controller('api/v1/cache')
export class CacheController {
  constructor(private readonly productCacheService: ProductCacheService) {}

  @Get('stats')
  getStats(): Promise<CacheStats> {
    return this.productCacheService.getStats();
  }
}
