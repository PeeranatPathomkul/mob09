import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import typeormConfig from './config/typeorm.config';
import { RedisModule } from './redis/redis.module';
import { OrdersWorkerModule } from './orders/orders-worker.module';

// Worker-side root module, bootstrapped by worker.main.ts. Kept separate from
// AppModule so api1/api2/api3 (which use AppModule) never load the BullMQ
// processor — only this module does, via OrdersWorkerModule.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [typeormConfig] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get('typeorm')!,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST'),
          port: Number(config.get<string>('REDIS_PORT') ?? 6379),
        },
      }),
    }),
    RedisModule,
    OrdersWorkerModule,
  ],
})
export class WorkerModule {}
