import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersLockReleaseListener } from './orders-lock-release.listener';

// API-side module: controller + producer + the lock-release listener.
// The BullMQ processor itself lives in orders-worker.module.ts so
// api1/api2/api3 never run the worker.
@Module({
  imports: [BullModule.registerQueue({ name: 'orders' })],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersLockReleaseListener],
})
export class OrdersModule {}
