import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CreateOrderDto } from './dto/create-order.dto';

@Injectable()
export class OrdersService {
  constructor(@InjectQueue('orders') private readonly ordersQueue: Queue) {}

  async createOrder(userId: string, dto: CreateOrderDto) {
    // jobId dedupes retries/duplicate submissions for the same user+product
    // so a client double-click doesn't enqueue the order twice.
    const jobId = `order:${userId}:${dto.productId}`;

    const job = await this.ordersQueue.add(
      'process-order',
      { userId, productId: dto.productId, quantity: dto.quantity },
      { jobId },
    );

    return { jobId: job.id, status: 'queued' };
  }
}
