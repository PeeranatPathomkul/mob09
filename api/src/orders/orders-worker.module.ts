import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../products/entities/product.entity';
import { Order } from './entities/order.entity';
import { ORDERS_QUEUE } from './orders.module';
import { OrdersLockReleaseListener } from './orders-lock-release.listener';
import { OrdersProcessor } from './orders.processor';
import { StockClaimService } from './stock-claim.service';

// Worker-side module: processor only, no controller/HTTP surface.
// Imported by worker.module.ts, never by app.module.ts.
//
// Also owns OrdersLockReleaseListener. It listens on QueueEvents, so it can
// run anywhere connected to the same Redis -- but running it on the api
// instances meant every one of them did the release work for every job, on
// the event loop serving incoming orders. One subscriber here does the same
// job once. If this process is down no jobs are completing either, so there
// are no releases being missed.
//
// No longer imports ProductsModule: cache invalidation is now a single INCR
// on the shared version key (see OrdersProcessor), so the worker does not
// need the read-side service at all.
@Module({
  imports: [BullModule.registerQueue({ name: ORDERS_QUEUE }), TypeOrmModule.forFeature([Product, Order])],
  providers: [OrdersProcessor, StockClaimService, OrdersLockReleaseListener],
})
export class OrdersWorkerModule {}
