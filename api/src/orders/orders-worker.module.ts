import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrdersProcessor } from './orders.processor';

// Worker-side module: processor only, no controller/HTTP surface.
// Imported by worker.module.ts, never by app.module.ts.
@Module({
  imports: [BullModule.registerQueue({ name: 'orders' })],
  providers: [OrdersProcessor],
})
export class OrdersWorkerModule {}
