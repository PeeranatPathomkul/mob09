import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from './entities/product.entity';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [TypeOrmModule.forFeature([Product])],
  controllers: [ProductsController],
  providers: [ProductsService],
  // Exported so OrdersWorkerModule can inject ProductsService to invalidate
  // the product cache after a stock update commits.
  exports: [ProductsService],
})
export class ProductsModule {}
