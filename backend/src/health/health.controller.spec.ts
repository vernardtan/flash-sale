import { jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service.js';
import { RedisService } from '../redis/redis.service.js';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  let controller: HealthController;
  const database = { ping: jest.fn<() => Promise<void>>() };
  const redis = { ping: jest.fn<() => Promise<void>>() };

  beforeEach(async () => {
    database.ping.mockReset();
    redis.ping.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: DatabaseService, useValue: database },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('reports ok when all dependencies are up', async () => {
    database.ping.mockResolvedValue(undefined);
    redis.ping.mockResolvedValue(undefined);

    await expect(controller.check()).resolves.toEqual({
      status: 'ok',
      dependencies: { database: 'up', redis: 'up' },
    });
  });

  it('throws 503 when the database is down', async () => {
    database.ping.mockRejectedValue(new Error('connection refused'));
    redis.ping.mockResolvedValue(undefined);

    await expect(controller.check()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('throws 503 when redis is down', async () => {
    database.ping.mockResolvedValue(undefined);
    redis.ping.mockRejectedValue(new Error('connection refused'));

    await expect(controller.check()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
