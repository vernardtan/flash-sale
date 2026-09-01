import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { PrismaClient, type Product } from '@prisma/client';
import { createTestApp } from './test-app.js';
import { cleanDatabase } from './test-db.js';

/**
 * Concurrency proofs for the purchase flow. All run against the real
 * PostgreSQL/Redis stack — these tests demonstrate that correctness is
 * enforced by the database, not by application-side luck.
 */

const RUN = Date.now().toString(36);
const HOUR = 60 * 60 * 1000;

async function seedProduct(
  prisma: PrismaClient,
  stock: number,
): Promise<Product> {
  const now = Date.now();
  return prisma.product.create({
    data: {
      name: 'Limited Edition Product',
      price: '1999.00',
      currency: 'PHP',
      totalStock: stock,
      remainingStock: stock,
      isEnabled: true,
      flashSales: {
        create: {
          startTime: new Date(now - HOUR),
          endTime: new Date(now + HOUR),
        },
      },
    },
  });
}

interface TxResult {
  status: number;
  code?: string;
}

async function attemptTransaction(
  server: Server,
  requestId: string,
  userId: string,
): Promise<TxResult> {
  const res = await request(server)
    .post('/api/transactions')
    .send({ requestId, userId });
  return { status: res.status, code: res.body?.code as string | undefined };
}

async function createCheckout(
  server: Server,
  productId: string,
  userId: string,
): Promise<string> {
  const res = await request(server)
    .post('/api/checkouts')
    .send({ userId, productId, quantity: 1, paymentMethod: 'GCASH' });
  expect(res.status).toBe(201);
  return (res.body as { requestId: string }).requestId;
}

describe('Concurrency (e2e)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let server: Server;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ({ app, server, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  it('sells exactly 10 items to 50 concurrent users — never oversells', async () => {
    const product = await seedProduct(prisma, 10);
    const userIds = Array.from({ length: 50 }, (_, i) => `u-${RUN}-${i}`);

    // 50 users check out concurrently (checkout never reserves stock).
    const requestIds = await Promise.all(
      userIds.map((id) => createCheckout(server, product.id, id)),
    );

    // Then all 50 race to complete the transaction.
    const results = await Promise.all(
      requestIds.map((requestId, i) =>
        attemptTransaction(server, requestId, userIds[i]),
      ),
    );

    const succeeded = results.filter((r) => r.status === 201);
    const soldOut = results.filter((r) => r.code === 'SOLD_OUT');

    expect(succeeded).toHaveLength(10);
    expect(soldOut).toHaveLength(40);

    const reloaded = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(reloaded.remainingStock).toBe(0);

    const purchases = await prisma.purchase.findMany();
    expect(purchases).toHaveLength(10);
    // Exactly one purchase per user.
    expect(new Set(purchases.map((p) => p.userId)).size).toBe(10);

    const completed = await prisma.checkout.count({
      where: { status: 'COMPLETED' },
    });
    expect(completed).toBe(10);
  });

  it('allows exactly one purchase for the same user under concurrent attempts', async () => {
    const product = await seedProduct(prisma, 10);
    const userId = `same-user-${RUN}`;

    // The user opens 5 checkouts (each is allowed pre-purchase) and fires
    // them all concurrently.
    const requestIds = await Promise.all(
      Array.from({ length: 5 }, () =>
        createCheckout(server, product.id, userId),
      ),
    );
    const results = await Promise.all(
      requestIds.map((requestId) =>
        attemptTransaction(server, requestId, userId),
      ),
    );

    const succeeded = results.filter((r) => r.status === 201);
    expect(succeeded).toHaveLength(1);
    for (const result of results) {
      if (result.status !== 201) {
        expect(['ALREADY_PURCHASED', 'REQUEST_ALREADY_PROCESSED']).toContain(
          result.code,
        );
      }
    }

    // The critical invariant: no extra stock consumed, exactly one purchase.
    const reloaded = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(reloaded.remainingStock).toBe(9);
    expect(await prisma.purchase.count()).toBe(1);

    // No checkout is left stuck in PROCESSING: losers either observed the
    // committed purchase (FAILED) or rolled back to PENDING after the
    // UNIQUE(user_id) violation.
    const stuck = await prisma.checkout.count({
      where: { status: 'PROCESSING' },
    });
    expect(stuck).toBe(0);
  });

  it('processes the same requestId exactly once under concurrent attempts', async () => {
    const product = await seedProduct(prisma, 10);
    const userId = `same-request-${RUN}`;
    const requestId = await createCheckout(server, product.id, userId);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        attemptTransaction(server, requestId, userId),
      ),
    );

    const succeeded = results.filter((r) => r.status === 201);
    expect(succeeded).toHaveLength(1);
    for (const result of results) {
      if (result.status !== 201) {
        expect([
          'TRANSACTION_PROCESSING',
          'REQUEST_ALREADY_PROCESSED',
        ]).toContain(result.code);
      }
    }

    const reloaded = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(reloaded.remainingStock).toBe(9);
    expect(await prisma.purchase.count()).toBe(1);

    const checkout = await prisma.checkout.findUniqueOrThrow({
      where: { requestId },
    });
    expect(checkout.status).toBe('COMPLETED');
  });

  it('returns TRANSACTION_PROCESSING immediately while the same request is PROCESSING', async () => {
    const product = await seedProduct(prisma, 1);
    const userId = `blocked-${RUN}`;
    const requestId = await createCheckout(server, product.id, userId);

    // Slow down the purchase phase so the checkout stays in PROCESSING long
    // enough for a concurrent same-requestId request to observe it.
    process.env.CHECKOUT_PROCESSING_DELAY_MS = '3000';

    // Request A starts, commits PROCESSING, then waits on the injected delay.
    const requestA = request(server)
      .post('/api/transactions')
      .send({ requestId, userId });

    // Wait until A has committed the PROCESSING claim before firing B.
    let claimed = false;
    while (!claimed) {
      const checkout = await prisma.checkout.findUnique({ where: { requestId } });
      claimed = checkout?.status === 'PROCESSING';
      if (!claimed) await new Promise((r) => setTimeout(r, 10));
    }

    // Request B must observe the committed PROCESSING state and return
    // immediately — not wait for A to finish.
    const startB = Date.now();
    const requestB = await request(server)
      .post('/api/transactions')
      .send({ requestId, userId });
    const elapsedB = Date.now() - startB;

    delete process.env.CHECKOUT_PROCESSING_DELAY_MS;

    expect(requestB.status).toBe(409);
    expect(requestB.body.code).toBe('TRANSACTION_PROCESSING');
    expect(elapsedB).toBeLessThan(500);

    const resultA = await requestA;
    expect(resultA.status).toBe(201);
    expect(resultA.body.status).toBe('COMPLETED');

    const reloaded = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(reloaded.remainingStock).toBe(0);
    expect(await prisma.purchase.count()).toBe(1);

    const checkout = await prisma.checkout.findUniqueOrThrow({
      where: { requestId },
    });
    expect(checkout.status).toBe('COMPLETED');
  });
});
