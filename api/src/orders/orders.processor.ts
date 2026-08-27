import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { Order, OrderStatus } from './entities/order.entity';
import { Product } from '../products/entities/product.entity';
import { ProductsService } from '../products/products.service';

interface ProcessOrderJobData {
  userId: string;
  productId: string;
  quantity: number;
}

const STOCK_LOCK_TTL_MS = 10_000;

@Processor('orders')
export class OrdersProcessor extends WorkerHost {
  private readonly logger = new Logger(OrdersProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly productsService: ProductsService,
  ) {
    super();
  }

  async process(job: Job<ProcessOrderJobData>): Promise<void> {
    const { userId, productId, quantity } = job.data;
    this.logger.log(`Processing order job ${job.id} for user=${userId} product=${productId} qty=${quantity}`);

    const lockKey = `stock-lock:${productId}`;
    const lockToken = `${job.id}:${Date.now()}`;

    // Redis distributed lock (SET NX PX) — serializes concurrent workers
    // touching the same product's stock.
    const gotLock = await this.redis.set(lockKey, lockToken, 'PX', STOCK_LOCK_TTL_MS, 'NX');
    if (gotLock !== 'OK') {
      // Another worker is mid-update for this product. Throw so BullMQ
      // retries the job instead of racing the current lock holder.
      throw new Error(`Could not acquire stock lock for product ${productId}, will retry`);
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        // Atomic conditional decrement: only matches (and only decrements)
        // if enough stock remains. This is the real guarantee against
        // overselling — it holds even if the Redis lock above were ever
        // bypassed or its TTL expired mid-operation.
        const updateResult = await manager
          .createQueryBuilder()
          .update(Product)
          .set({ remainingStock: () => 'remaining_stock - :quantity' })
          .where('id = :productId AND remaining_stock >= :quantity')
          .setParameters({ productId, quantity })
          .execute();

        if (updateResult.affected === 0) {
          throw new Error(`Insufficient stock for product ${productId}`);
        }

        const order = manager.create(Order, {
          userId,
          productId,
          quantity,
          status: OrderStatus.CONFIRMED,
        });

        // @Unique(['userId', 'productId']) on Order is the last line of
        // defense against a duplicate purchase slipping past the Redis
        // lock in orders.service.ts (e.g. after that lock's TTL expires).
        await manager.save(order);
      });

      // Stock changed — drop cached product pages so GET /products reflects
      // the new remainingStock immediately.
      await this.productsService.invalidateProductCache();
    } catch (err) {
      this.logger.warn(`Order job ${job.id} failed: ${(err as Error).message}`);
      throw err;
    } finally {
      // Only release the lock if we still hold it (best-effort check-then-
      // delete; a Lua compare-and-delete script would be safer under heavy
      // contention, but this is sufficient given the short TTL here).
      const current = await this.redis.get(lockKey);
      if (current === lockToken) {
        await this.redis.del(lockKey);
      }
    }
  }
}