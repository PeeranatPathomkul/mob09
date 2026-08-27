import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { Product } from './entities/product.entity';

const CACHE_TTL_SECONDS = 30;

// Spec 2.2 response shape.
export interface ProductDto {
  productId: string;
  name: string;
  price: number;
  availableStock: number;
  remainingStock: number;
  isFlashSaleActive: boolean;
}

export interface ProductsPageResult {
  data: ProductDto[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  private cacheKey(page: number, limit: number) {
    return `products:page:${page}:limit:${limit}`;
  }

  private toDto(product: Product): ProductDto {
    return {
      productId: product.id,
      name: product.name,
      price: Number(product.price),
      availableStock: product.totalStock,
      remainingStock: product.remainingStock,
      isFlashSaleActive: product.isFlashSaleActive,
    };
  }

  async findAll(page: number, limit: number): Promise<ProductsPageResult> {
    const key = this.cacheKey(page, limit);

    // Cache-aside read: try Redis first.
    const cached = await this.redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }

    // Miss: read from Postgres and populate the cache with a TTL so a stale
    // entry self-heals even if an invalidation is ever missed.
    const [items, total] = await this.productsRepository.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    const result: ProductsPageResult = {
      data: items.map((item) => this.toDto(item)),
      meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };

    await this.redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
    return result;
  }

  /**
   * Called by the orders worker right after a stock decrement commits, so
   * GET /api/v1/products stops serving a stale remainingStock.
   *
   * Pages are cached by page/limit rather than by productId, so we can't
   * target a single key. We SCAN (never KEYS, which blocks Redis) over the
   * products:page:* keyspace and drop every cached page — simple and safe
   * for this dataset's size; the 30s TTL is a backstop if this is ever
   * skipped.
   */
  async invalidateProductCache(): Promise<void> {
    const stream = this.redis.scanStream({ match: 'products:page:*', count: 100 });
    const keysToDelete: string[] = [];

    for await (const keys of stream) {
      keysToDelete.push(...(keys as string[]));
    }

    if (keysToDelete.length) {
      await this.redis.del(...keysToDelete);
    }
  }
}