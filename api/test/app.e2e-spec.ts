import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { App } from 'supertest/types';
import { Redis } from 'ioredis';
import { AppModule } from './../src/app.module';
import { REDIS_CLIENT } from './../src/redis/redis.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('product cache reads the version off the configured CACHE_VERSION_KEY, not a hardcoded key name', async () => {
    const redis = app.get<Redis>(REDIS_CLIENT);
    const config = app.get(ConfigService);
    const versionKey =
      config.get<string>('CACHE_VERSION_KEY') ?? 'products:cache:version';

    await redis.del(versionKey);
    const baseVersion = Number((await redis.get(versionKey)) ?? 0); // 0, right after del

    await request(app.getHttpServer())
      .get('/api/v1/products?page=1&limit=10')
      .expect(200);
    expect(
      await redis.get(`products:page:1:limit:10:v:${baseVersion}`),
    ).not.toBeNull();

    // Bumping the *configured* version key (whatever CACHE_VERSION_KEY names)
    // must be what moves the page cache to a new key — proves the service
    // isn't reading some other, hardcoded version key.
    await redis.incr(versionKey);
    await request(app.getHttpServer())
      .get('/api/v1/products?page=1&limit=10')
      .expect(200);
    expect(
      await redis.get(`products:page:1:limit:10:v:${baseVersion + 1}`),
    ).not.toBeNull();
  });

  afterEach(async () => {
    await app.close();
  });
});
