import 'dotenv/config';
import { DataSource } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { Order } from '../orders/entities/order.entity';

// Standalone DataSource for scripts (seeding, future migrations) that run
// outside the Nest application context. The app itself gets its TypeORM
// config from config/typeorm.config.ts.
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  entities: [Product, Order],
  synchronize: true,
});
