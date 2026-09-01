/**
 * Boots the real NestJS application for e2e tests, mirroring main.ts
 * (global prefix + ValidationPipe) against the flash_sale_test database.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module.js';
import { setupTestDatabase } from './test-db.js';

export interface TestApp {
  app: INestApplication;
  server: Server;
  /** Direct Prisma access for fixtures and DB-state assertions. */
  prisma: PrismaClient;
}

export async function createTestApp(): Promise<TestApp> {
  const prisma = await setupTestDatabase();

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  return { app, server: app.getHttpServer() as Server, prisma };
}
