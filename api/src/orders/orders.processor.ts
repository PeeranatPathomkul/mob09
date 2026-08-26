import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

interface ProcessOrderJobData {
  userId: string;
  productId: string;
  quantity: number;
}

@Processor('orders')
export class OrdersProcessor extends WorkerHost {
  private readonly logger = new Logger(OrdersProcessor.name);

  async process(job: Job<ProcessOrderJobData>): Promise<void> {
    const { userId, productId, quantity } = job.data;
    this.logger.log(`Processing order job ${job.id} for user=${userId} product=${productId} qty=${quantity}`);

    // TODO: NOT IMPLEMENTED — Redis distributed lock (e.g. per productId) is
    // required here before touching stock, otherwise concurrent workers can
    // both read the same remaining_stock and oversell. Do not remove this
    // comment until a real lock (e.g. Redlock/SET NX PX) guards this block.

    // TODO: NOT IMPLEMENTED — Worker DB transaction is required here:
    // 1) SELECT ... FOR UPDATE (or atomic UPDATE ... WHERE remaining_stock >= quantity)
    //    on the product row to decrement remaining_stock,
    // 2) insert the Order row,
    // both inside a single transaction that rolls back on failure/insufficient stock.
    // Nothing below actually reserves stock or persists an order yet.
  }
}
