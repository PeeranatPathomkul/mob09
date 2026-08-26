import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { Product } from './entities/product.entity';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  async findAll(page: number, limit: number) {
    // TODO: Cache-Aside pattern not implemented yet.
    // Should check Redis for a cached page first, and on a miss, read from
    // Postgres and populate the cache with a TTL. Currently this always hits
    // the database directly.
    void this.redis;

    const [items, total] = await this.productsRepository.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return { items, total, page, limit };
  }
}
