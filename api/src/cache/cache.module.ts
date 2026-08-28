import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { ProductsController } from '../products/products.controller';
import { CacheController } from './cache.controller';
import { ProductCacheService } from './product-cache.service';

// Owns the read path end to end: DB access (via ProductsModule),
// caching (ProductCacheService), and both HTTP controllers.
//
// ProductsController is registered here rather than in ProductsModule so it
// can inject ProductCacheService directly, without ProductsModule having to
// import CacheModule back (which would be circular).
@Module({
  imports: [ProductsModule],
  controllers: [ProductsController, CacheController],
  providers: [ProductCacheService],
  exports: [ProductCacheService],
})
export class CacheModule {}
