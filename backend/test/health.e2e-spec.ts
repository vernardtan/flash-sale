import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppModule } from '../src/app.module.js';

// Requires PostgreSQL and Redis reachable at DATABASE_HOST / REDIS_HOST
// (defaults: localhost, as published by docker compose).
describe('Health (e2e)', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('/api/health (GET) reports dependency status', async () => {
    const response: request.Response = await request(server).get('/api/health');
    const body = response.body as Record<string, unknown>;

    expect([200, 503]).toContain(response.status);
    expect(body).toMatchObject({
      status: expect.stringMatching(/^(ok|degraded)$/),
      dependencies: {
        database: expect.stringMatching(/^(up|down)$/),
        redis: expect.stringMatching(/^(up|down)$/),
      },
    });
  });
});
