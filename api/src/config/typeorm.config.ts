import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Product } from '../products/entities/product.entity';
import { Order } from '../orders/entities/order.entity';

/**
 * Pool sizing rule: DB_POOL_MAX = WORKER_CONCURRENCY + 2.
 *
 * Every in-flight job holds one connection for the whole transaction, so a
 * pool smaller than the concurrency means workers block waiting for a
 * connection *before* they ever get to wait for the row lock — moving the
 * queue somewhere it cannot be observed. The +2 leaves headroom for the
 * out-of-band queries (the replay lookup after a unique violation runs on its
 * own connection by design) without over-provisioning the database.
 */
const DEFAULT_CONCURRENCY = 10;

export default registerAs('typeorm', (): TypeOrmModuleOptions => {
  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? DEFAULT_CONCURRENCY);
  const poolMax = Number(process.env.DB_POOL_MAX ?? concurrency + 2);

  return {
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    entities: [Product, Order],
    // TODO: disable synchronize and use migrations once schema stabilizes
    synchronize: true,
    extra: {
      max: poolMax,
      // Surface pool exhaustion as an error instead of hanging forever.
      connectionTimeoutMillis: 5000,
    },
  };
});
