import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './entities/product.entity';

// Spec 2.2 response shape.
export interface ProductDto {
  productId: string;
  name: string;
  price: number;
  availableStock: number;
  remainingStock: number;
  isFlashSaleActive: boolean;
}

export interface ProductsPageMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ProductsPage {
  data: ProductDto[];
  meta: ProductsPageMeta;
}

/**
 * DB-only read path. Caching (page cache, version invalidation, stats,
 * single-flight) lives entirely in ProductCacheService — this service knows
 * nothing about Redis.
 */
@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
  ) {}

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

  async findPageFromDb(page: number, limit: number): Promise<ProductsPage> {
    const [items, total] = await this.productsRepository.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return {
      data: items.map((item) => this.toDto(item)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }
}
