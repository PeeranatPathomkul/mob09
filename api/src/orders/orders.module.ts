import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

// API-side module: controller + producer only. The processor lives in
// orders-worker.module.ts so api1/api2/api3 never run the BullMQ worker.
@Module({
  imports: [BullModule.registerQueue({ name: 'orders' })],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
