import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import type { PrismaClient, Product } from '@prisma/client';
import { createTestApp } from './test-app.js';
import { cleanDatabase } from './test-db.js';

/**
 * End-to-end coverage of the Phase 4 business APIs against the real
 * flash_sale_test database and Redis (both published by docker compose).
 */

const RUN = Date.now().toString(36);
const user = (label: string) => `user-${RUN}-${label}`;

const HOUR = 60 * 60 * 1000;

async function seedProduct(
  prisma: PrismaClient,
  overrides: {
    stock?: number;
    isEnabled?: boolean;
    startOffsetMs?: number;
    endOffsetMs?: number;
  } = {},
): Promise<Product> {
  const {
    stock = 10,
    isEnabled = true,
    startOffsetMs = -HOUR,
    endOffsetMs = HOUR,
  } = overrides;
  const now = Date.now();
  const product = await prisma.product.create({
    data: {
      name: 'Limited Edition Product',
      description: 'Limited-edition flash sale product',
      price: '1999.00',
      currency: 'PHP',
      totalStock: stock,
      remainingStock: stock,
      isEnabled,
      flashSales: {
        create: {
          startTime: new Date(now + startOffsetMs),
          endTime: new Date(now + endOffsetMs),
        },
      },
    },
  });
  return product;
}

async function seedRegularProduct(
  prisma: PrismaClient,
  overrides: { stock?: number; isEnabled?: boolean; price?: string } = {},
): Promise<Product> {
  const { stock = 10, isEnabled = true, price = '599.00' } = overrides;
  return prisma.product.create({
    data: {
      name: 'Regular Product',
      description: 'Always-available regular product',
      price,
      currency: 'PHP',
      totalStock: stock,
      remainingStock: stock,
      isEnabled,
    },
  });
}

async function createCheckout(
  server: Server,
  productId: string,
  userId: string,
  overrides: Record<string, unknown> = {},
): Promise<request.Response> {
  return request(server)
    .post('/api/checkouts')
    .send({
      userId,
      productId,
      quantity: 1,
      paymentMethod: 'GCASH',
      ...overrides,
    });
}

describe('Flash Sale API (e2e)', () => {
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

  describe('GET /api/sale/status', () => {
    it('reports ACTIVE with sale details inside the window', async () => {
      const product = await seedProduct(prisma, { stock: 73 });
      const res = await request(server).get('/api/sale/status');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'ACTIVE',
        productId: product.id,
        remainingStock: 73,
      });
      expect(typeof res.body.startTime).toBe('string');
      expect(typeof res.body.endTime).toBe('string');
    });

    it('reports UPCOMING before the start time', async () => {
      await seedProduct(prisma, { startOffsetMs: HOUR, endOffsetMs: 2 * HOUR });
      const res = await request(server).get('/api/sale/status');
      expect(res.body.status).toBe('UPCOMING');
    });

    it('reports ENDED after the end time', async () => {
      await seedProduct(prisma, {
        startOffsetMs: -2 * HOUR,
        endOffsetMs: -HOUR,
      });
      const res = await request(server).get('/api/sale/status');
      expect(res.body.status).toBe('ENDED');
    });

    it('reports SOLD_OUT when stock is exhausted', async () => {
      await seedProduct(prisma, { stock: 0 });
      const res = await request(server).get('/api/sale/status');
      expect(res.body.status).toBe('SOLD_OUT');
    });

    it('reports DISABLED when the product is disabled', async () => {
      await seedProduct(prisma, { isEnabled: false });
      const res = await request(server).get('/api/sale/status');
      expect(res.body.status).toBe('DISABLED');
    });
  });

  describe('GET /api/products', () => {
    it('returns the product with price, sale info, and availability', async () => {
      const product = await seedProduct(prisma, { stock: 25 });
      const res = await request(server).get('/api/products');

      expect(res.status).toBe(200);
      expect(res.body.products).toHaveLength(1);
      expect(res.body.products[0]).toMatchObject({
        id: product.id,
        name: 'Limited Edition Product',
        price: '1999.00',
        currency: 'PHP',
        remainingStock: 25,
        sale: { status: 'ACTIVE' },
        eligibility: null,
        buyNowAvailable: true,
      });
    });

    it('marks a user who already purchased as ineligible', async () => {
      const product = await seedProduct(prisma);
      const userId = user('eligible');
      const checkout = await createCheckout(server, product.id, userId);
      await request(server)
        .post('/api/transactions')
        .send({ requestId: checkout.body.requestId, userId });

      const res = await request(server).get('/api/products').query({ userId });
      expect(res.body.products[0].eligibility).toEqual({
        eligible: false,
        reason: 'ALREADY_PURCHASED',
      });
      expect(res.body.products[0].buyNowAvailable).toBe(false);
    });
  });

  describe('GET /api/payment-methods', () => {
    it('returns the mocked payment methods', async () => {
      const res = await request(server).get('/api/payment-methods');
      expect(res.status).toBe(200);
      expect(res.body.paymentMethods).toEqual(
        expect.arrayContaining([
          { id: 'GCASH', name: 'GCash' },
          { id: 'MAYA', name: 'Maya' },
          { id: 'CARD', name: 'Credit/Debit Card' },
        ]),
      );
    });
  });

  describe('POST /api/checkouts', () => {
    it('creates a PENDING checkout with server-generated requestId and price snapshot, without touching stock', async () => {
      const product = await seedProduct(prisma, { stock: 10 });
      const before = Date.now();

      const res = await createCheckout(server, product.id, user('happy'));

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'PENDING',
        productId: product.id,
        quantity: 1,
        unitPrice: '1999.00',
        currency: 'PHP',
      });
      expect(res.body.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      const expiresAt = new Date(res.body.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 899_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 901_000);

      const reloaded = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(reloaded.remainingStock).toBe(10);
    });

    it('rejects quantity other than 1 for flash-sale product', async () => {
      const product = await seedProduct(prisma);
      const res = await createCheckout(server, product.id, user('qty'), {
        quantity: 2,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_QUANTITY');
    });

    it('rejects unsupported payment methods', async () => {
      const product = await seedProduct(prisma);
      const res = await createCheckout(server, product.id, user('pay'), {
        paymentMethod: 'BITCOIN',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects unknown products', async () => {
      const res = await createCheckout(
        server,
        '1c0e4b8a-7f6d-4e5a-9c3b-2d1f0e8a7b6c',
        user('unknown'),
      );
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PRODUCT_NOT_FOUND');
    });

    it('rejects disabled products', async () => {
      const product = await seedProduct(prisma, { isEnabled: false });
      const res = await createCheckout(server, product.id, user('disabled'));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PRODUCT_DISABLED');
    });

    it('rejects when the sale is upcoming', async () => {
      const product = await seedProduct(prisma, {
        startOffsetMs: HOUR,
        endOffsetMs: 2 * HOUR,
      });
      const res = await createCheckout(server, product.id, user('upcoming'));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SALE_UPCOMING');
    });

    it('rejects when the sale has ended', async () => {
      const product = await seedProduct(prisma, {
        startOffsetMs: -2 * HOUR,
        endOffsetMs: -HOUR,
      });
      const res = await createCheckout(server, product.id, user('ended'));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SALE_ENDED');
    });

    it('rejects when sold out', async () => {
      const product = await seedProduct(prisma, { stock: 0 });
      const res = await createCheckout(server, product.id, user('soldout'));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOLD_OUT');
    });

    it('rejects malformed payloads with VALIDATION_FAILED', async () => {
      const res = await request(server)
        .post('/api/checkouts')
        .send({ productId: 'not-a-uuid' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/transactions', () => {
    it('completes a purchase: stock -1, purchase created, checkout COMPLETED', async () => {
      const product = await seedProduct(prisma, { stock: 5 });
      const userId = user('buyer');
      const checkout = await createCheckout(server, product.id, userId);
      const { requestId } = checkout.body as { requestId: string };

      const res = await request(server)
        .post('/api/transactions')
        .send({ requestId, userId });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        requestId,
        status: 'COMPLETED',
        productId: product.id,
        quantity: 1,
        unitPrice: '1999.00',
        totalAmount: '1999.00',
        currency: 'PHP',
        paymentMethod: 'GCASH',
      });

      const reloaded = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(reloaded.remainingStock).toBe(4);

      const purchase = await prisma.purchase.findFirstOrThrow({
        where: { userId, isFlashSale: true },
      });
      expect(purchase.requestId).toBe(requestId);

      const updatedCheckout = await prisma.checkout.findUniqueOrThrow({
        where: { requestId },
      });
      expect(updatedCheckout.status).toBe('COMPLETED');

      // GET /api/purchases/:userId reflects the purchase.
      const purchaseRes = await request(server).get(`/api/purchases/${userId}`);
      expect(purchaseRes.status).toBe(200);
      expect(purchaseRes.body).toMatchObject({
        productId: product.id,
        quantity: 1,
        totalAmount: '1999.00',
        paymentMethod: 'GCASH',
      });
    });

    it('rejects reusing a completed requestId', async () => {
      const product = await seedProduct(prisma);
      const userId = user('reuse');
      const checkout = await createCheckout(server, product.id, userId);
      const { requestId } = checkout.body as { requestId: string };
      await request(server)
        .post('/api/transactions')
        .send({ requestId, userId });

      const res = await request(server)
        .post('/api/transactions')
        .send({ requestId, userId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REQUEST_ALREADY_PROCESSED');

      const reloaded = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(reloaded.remainingStock).toBe(9);
    });

    it('rejects reusing a failed requestId', async () => {
      const product = await seedProduct(prisma, { stock: 5 });
      const userId = user('failed-reuse');
      const checkout = await createCheckout(server, product.id, userId);
      const { requestId } = checkout.body as { requestId: string };

      // Force the checkout to FAILED by exhausting stock, then attempting it.
      await prisma.product.update({
        where: { id: product.id },
        data: { remainingStock: 0 },
      });
      await request(server)
        .post('/api/transactions')
        .send({ requestId, userId });

      const res = await request(server)
        .post('/api/transactions')
        .send({ requestId, userId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REQUEST_ALREADY_PROCESSED');

      const reloaded = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(reloaded.remainingStock).toBe(0);
      expect(await prisma.purchase.count()).toBe(0);
    });

    it('returns TRANSACTION_PROCESSING for a freshly seeded PROCESSING checkout', async () => {
      const product = await seedProduct(prisma, { stock: 5 });
      const userId = user('processing-fresh');
      const requestId = crypto.randomUUID();
      await prisma.checkout.create({
        data: {
          requestId,
          userId,
          productId: product.id,
          quantity: 1,
          unitPrice: product.price,
          currency: 'PHP',
          paymentMethod: 'GCASH',
          status: 'PROCESSING',
          expiresAt: new Date(Date.now() + 900_000),
          updatedAt: new Date(),
        },
      });

      const res = await request(server)
        .post('/api/transactions')
        .send({ requestId, userId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TRANSACTION_PROCESSING');

      const reloaded = await prisma.checkout.findUniqueOrThrow({
        where: { requestId },
      });
      expect(reloaded.status).toBe('PROCESSING');
    });

    it('recovers a stale PROCESSING checkout to FAILED', async () => {
      const product = await seedProduct(prisma, { stock: 5 });
      const userId = user('processing-stale');
      const requestId = crypto.randomUUID();
      await prisma.checkout.create({
        data: {
          requestId,
          userId,
          productId: product.id,
          quantity: 1,
          unitPrice: product.price,
          currency: 'PHP',
          paymentMethod: 'GCASH',
          status: 'PROCESSING',
          expiresAt: new Date(Date.now() + 900_000),
          updatedAt: new Date(Date.now() - 400_000),
        },
      });

      const res = await request(server)
        .post('/api/transactions')
        .send({ requestId, userId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REQUEST_ALREADY_PROCESSED');

      const reloaded = await prisma.checkout.findUniqueOrThrow({
        where: { requestId },
      });
      expect(reloaded.status).toBe('FAILED');
      expect(await prisma.purchase.count()).toBe(0);
    });

    it('rejects unknown requestIds', async () => {
      await seedProduct(prisma);
      const res = await request(server)
        .post('/api/transactions')
        .send({ requestId: crypto.randomUUID(), userId: user('ghost') });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('CHECKOUT_NOT_FOUND');
    });

    it("rejects using another user's requestId without leaking ownership", async () => {
      const product = await seedProduct(prisma);
      const checkout = await createCheckout(server, product.id, user('owner'));
      const res = await request(server)
        .post('/api/transactions')
        .send({
          requestId: (checkout.body as { requestId: string }).requestId,
          userId: user('thief'),
        });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('REQUEST_NOT_AUTHORIZED');
    });

    it('rejects expired checkouts and marks them EXPIRED', async () => {
      const product = await seedProduct(prisma);
      const userId = user('slow');
      const checkout = await createCheckout(server, product.id, userId);
      const { requestId } = checkout.body as { requestId: string };

      await prisma.checkout.update({
        where: { requestId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await request(server)
        .post('/api/transactions')
        .send({ requestId, userId });
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('CHECKOUT_EXPIRED');

      const updated = await prisma.checkout.findUniqueOrThrow({
        where: { requestId },
      });
      expect(updated.status).toBe('EXPIRED');
    });

    it('rejects a second purchase for the same user and preserves stock', async () => {
      const product = await seedProduct(prisma, { stock: 5 });
      const userId = user('twice');

      const first = await createCheckout(server, product.id, userId);
      await request(server)
        .post('/api/transactions')
        .send({ requestId: first.body.requestId, userId });

      // Second checkout attempt is already blocked at creation.
      const second = await createCheckout(server, product.id, userId);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('ALREADY_PURCHASED');

      const reloaded = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(reloaded.remainingStock).toBe(4);
      expect(await prisma.purchase.count()).toBe(1);
    });

    it('rejects malformed transaction payloads', async () => {
      await seedProduct(prisma);
      const res = await request(server)
        .post('/api/transactions')
        .send({ requestId: 'nope' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/purchases/:userId', () => {
    it('returns 404 for users without a purchase', async () => {
      const res = await request(server).get(`/api/purchases/${user('none')}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PURCHASE_NOT_FOUND');
    });
  });

  describe('Regular product purchase behavior', () => {
    it('allows the same user to purchase a regular product multiple times', async () => {
      const product = await seedRegularProduct(prisma, { stock: 5 });
      const userId = user('regular-repeat');

      const firstCheckout = await createCheckout(server, product.id, userId, {
        quantity: 1,
      });
      expect(firstCheckout.status).toBe(201);
      const firstTx = await request(server)
        .post('/api/transactions')
        .send({ requestId: firstCheckout.body.requestId, userId });
      expect(firstTx.status).toBe(201);
      expect(firstTx.body.status).toBe('COMPLETED');

      const secondCheckout = await createCheckout(server, product.id, userId, {
        quantity: 1,
      });
      expect(secondCheckout.status).toBe(201);
      const secondTx = await request(server)
        .post('/api/transactions')
        .send({ requestId: secondCheckout.body.requestId, userId });
      expect(secondTx.status).toBe(201);
      expect(secondTx.body.status).toBe('COMPLETED');

      const reloaded = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(reloaded.remainingStock).toBe(3);
      expect(await prisma.purchase.count()).toBe(2);
    });

    it('rejects quantity less than 1 for a regular product', async () => {
      const product = await seedRegularProduct(prisma);
      const res = await createCheckout(server, product.id, user('bad-qty'), {
        quantity: 0,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_QUANTITY');
    });

    it('rejects a regular product purchase when quantity exceeds stock', async () => {
      const product = await seedRegularProduct(prisma, { stock: 2 });
      const userId = user('regular-too-many');
      const checkout = await createCheckout(server, product.id, userId, {
        quantity: 5,
      });
      expect(checkout.status).toBe(201);
      const { requestId } = checkout.body as { requestId: string };

      const res = await request(server)
        .post('/api/transactions')
        .send({ requestId, userId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOLD_OUT');

      const reloaded = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(reloaded.remainingStock).toBe(2);
      expect(await prisma.purchase.count()).toBe(0);

      const updated = await prisma.checkout.findUniqueOrThrow({
        where: { requestId },
      });
      expect(updated.status).toBe('FAILED');
    });
  });
});

describe('Flash sale feature flag (e2e)', () => {
  const PREV = process.env.FLASH_SALE_ENABLED;
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaClient;

  beforeAll(async () => {
    process.env.FLASH_SALE_ENABLED = 'false';
    ({ app, server, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    process.env.FLASH_SALE_ENABLED = PREV;
  });

  it('reports DISABLED and rejects checkouts when the flag is off', async () => {
    await cleanDatabase(prisma);
    const product = await seedProduct(prisma);

    const status = await request(server).get('/api/sale/status');
    expect(status.body.status).toBe('DISABLED');

    const checkout = await createCheckout(server, product.id, user('flagoff'));
    expect(checkout.status).toBe(409);
    expect(checkout.body.code).toBe('SALE_DISABLED');
  });
});
