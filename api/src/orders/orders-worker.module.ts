import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ProductsModule } from '../products/products.module';
import { OrdersProcessor } from './orders.processor';

// Worker-side module: processor only, no controller/HTTP surface.
// Imported by worker.module.ts, never by app.module.ts.
// Imports ProductsModule so OrdersProcessor can invalidate the product
// cache after a stock update commits.
@Module({
  imports: [BullModule.registerQueue({ name: 'orders' }), ProductsModule],
  providers: [OrdersProcessor],
})
export class OrdersWorkerModule {}
