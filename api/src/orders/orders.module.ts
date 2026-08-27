import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersLockReleaseListener } from './orders-lock-release.listener';

/** Single source of truth for the queue name, shared by producer and worker. */
export const ORDERS_QUEUE = 'orders';

// API-side module: controller + producer + the lock-release listener.
// The BullMQ processor itself lives in orders-worker.module.ts so
// api1/api2/api3 never run the worker.
@Module({
  imports: [BullModule.registerQueue({ name: ORDERS_QUEUE })],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersLockReleaseListener],
})
export class OrdersModule {}
