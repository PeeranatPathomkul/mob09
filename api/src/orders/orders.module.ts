import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/** Single source of truth for the queue name, shared by producer and worker. */
export const ORDERS_QUEUE = 'orders';

// API-side module: controller + producer only.
//
// The lock-release listener used to live here, which put a QueueEvents
// subscriber on EVERY api instance: each one woke up and ran a Lua
// compare-and-delete for every job the worker finished, on the same event
// loop that was serving the write burst -- 500 jobs x 4 instances of work
// competing with the requests it was supposed to be answering. It is a
// worker-side concern, so it now lives in orders-worker.module.ts.
//
// The BullMQ processor itself lives there too, so api instances never run
// the worker.
@Module({
  imports: [BullModule.registerQueue({ name: ORDERS_QUEUE })],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
