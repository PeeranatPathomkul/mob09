import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

// Worker entrypoint — no HTTP server. Bootstraps as an application context
// so the BullMQ processor registered in WorkerModule starts consuming jobs.
async function bootstrap() {
  await NestFactory.createApplicationContext(WorkerModule);
}
bootstrap();
