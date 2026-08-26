# mob09
Backend Assignment (mobile application module)

## Flash Sale System

Stack: NestJS + PostgreSQL (TypeORM) + Redis + BullMQ + Nginx + JWT (stateless)

Run `docker compose up --build` to bring up postgres, redis, 3 API instances, a BullMQ worker, Bull Board, and nginx.

To seed sample products into Postgres:

```
docker compose exec api1 node dist/database/seed.js
```
