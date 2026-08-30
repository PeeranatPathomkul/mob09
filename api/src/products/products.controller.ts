import { Controller, Get, Header, Query, Res } from '@nestjs/common';
// `import type`: the project has isolatedModules + emitDecoratorMetadata on,
// which rejects a value import used only as a type in a decorated signature.
import type { Response } from 'express';
import { ListProductsQueryDto } from '../cache/dto/list-products-query.dto';
import {
  ProductCacheService,
  ProductsPageResponse,
} from '../cache/product-cache.service';

@Controller('api/v1/products')
export class ProductsController {
  constructor(private readonly productCacheService: ProductCacheService) {}

  @Get()
  // The whole point of X-Cache is that it describes THIS response, so it must
  // never be reused for the next one. Without this, a proxy could serve a
  // cached copy carrying a stale X-Cache and the measurement would lie.
  @Header('Cache-Control', 'no-store')
  async findAll(
    @Query() query: ListProductsQueryDto,
    // passthrough: Nest still serialises the returned body itself; we only
    // reach for the response object to set a header alongside it.
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductsPageResponse> {
    const { body, cacheStatus } =
      await this.productCacheService.getProductsPageWithStatus(
        query.page,
        query.limit,
      );

    // HIT / MISS / BYPASS — the only per-request view of cache behaviour.
    // /api/v1/cache/stats reports process-wide totals, which cannot attribute
    // anything to an individual request once more than one client is active.
    res.setHeader('X-Cache', cacheStatus);
    return body;
  }
}
