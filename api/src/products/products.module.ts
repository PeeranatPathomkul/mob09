import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './entities/product.entity';
import { ProductsService } from './products.service';

// DB-only now: no controller here (moved to CacheModule, which registers
// ProductsController so it can inject ProductCacheService without a
// CacheModule <-> ProductsModule circular dependency).
@Module({
  imports: [TypeOrmModule.forFeature([Product])],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
