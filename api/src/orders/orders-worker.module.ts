import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../products/entities/product.entity';
import { Order } from './entities/order.entity';
import { ORDERS_QUEUE } from './orders.module';
import { OrdersProcessor } from './orders.processor';
import { StockClaimService } from './stock-claim.service';

// Worker-side module: processor only, no controller/HTTP surface.
// Imported by worker.module.ts, never by app.module.ts.
//
// No longer imports ProductsModule: cache invalidation is now a single INCR
// on the shared version key (see OrdersProcessor), so the worker does not
// need the read-side service at all.
@Module({
  imports: [BullModule.registerQueue({ name: ORDERS_QUEUE }), TypeOrmModule.forFeature([Product, Order])],
  providers: [OrdersProcessor, StockClaimService],
})
export class OrdersWorkerModule {}
