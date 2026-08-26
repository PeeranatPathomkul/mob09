import { readFileSync } from 'fs';
import { join } from 'path';
import { AppDataSource } from './data-source';
import { Product } from '../products/entities/product.entity';

interface SeedProduct {
  productId: string;
  name: string;
  description: string;
  price: number;
  availableStock: number;
  isFlashSaleActive: boolean;
}

async function seed() {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(Product);

  // ../../seed resolves the same way from src/database (ts-node) and
  // dist/database (compiled), since seed/ sits one level above src/dist.
  const seedPath = join(__dirname, '../../seed/products-seed.json');
  const products: SeedProduct[] = JSON.parse(readFileSync(seedPath, 'utf-8'));

  for (const p of products) {
    await repo.upsert(
      {
        id: p.productId,
        name: p.name,
        description: p.description,
        price: p.price.toFixed(2),
        totalStock: p.availableStock,
        remainingStock: p.availableStock,
        isFlashSaleActive: p.isFlashSaleActive,
      },
      ['id'],
    );
  }

  console.log(`Seeded ${products.length} products.`);
  await AppDataSource.destroy();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
