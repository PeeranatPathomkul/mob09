import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService) => {
        return new Redis({
          host: config.get<string>('REDIS_HOST'),
          port: Number(config.get<string>('REDIS_PORT') ?? 6379),
          // One client per process, shared by the read cache and the order
          // lock, and ioredis writes each command to the socket as its own
          // syscall. Auto-pipelining batches every command issued in the same
          // event-loop tick into a single write instead -- which is exactly
          // the shape of this load: hundreds of concurrent requests each
          // issuing one or two small commands at the same instant.
          //
          // Purely a transport optimisation: ordering, replies and error
          // handling are unchanged, so callers see no difference.
          enableAutoPipelining: true,
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
