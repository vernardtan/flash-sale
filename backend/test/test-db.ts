/**
 * Shared helpers for e2e tests running against the Docker-published
 * PostgreSQL port on the host. Uses a dedicated flash_sale_test database,
 * created and migrated on demand (idempotent).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

export const TEST_DATABASE_URL =
  'postgresql://flash_sale:flash_sale_dev@localhost:5432/flash_sale_test';

const ADMIN_DATABASE_URL =
  'postgresql://flash_sale:flash_sale_dev@localhost:5432/postgres';

const BACKEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// Run the local CLI entrypoints through node directly: cross-platform
// (npx/prisma resolve to .cmd shims on Windows) and works without npm.
const PRISMA_CLI = path.join('node_modules', 'prisma', 'build', 'index.js');
const TSX_CLI = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');

export function migrateTestDatabase(databaseUrl = TEST_DATABASE_URL): void {
  execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}

export function runSeed(databaseUrl = TEST_DATABASE_URL): void {
  execFileSync(process.execPath, [TSX_CLI, 'prisma/seed.ts'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}

let initialized: Promise<PrismaClient> | undefined;

/** Create (if needed), migrate, and connect to the test database. */
export function setupTestDatabase(): Promise<PrismaClient> {
  initialized ??= (async () => {
    const admin = new PrismaClient({
      datasources: { db: { url: ADMIN_DATABASE_URL } },
    });
    try {
      await admin.$executeRawUnsafe('CREATE DATABASE flash_sale_test');
    } catch (error) {
      // 42P04 duplicate_database: the test database already exists.
      if (!String(error).includes('already exists')) throw error;
    } finally {
      await admin.$disconnect();
    }

    migrateTestDatabase();

    return new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL } },
    });
  })();
  return initialized;
}

/** Delete all rows in FK-safe order. */
export async function cleanDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.purchase.deleteMany();
  await prisma.checkout.deleteMany();
  await prisma.flashSale.deleteMany();
  await prisma.product.deleteMany();
}
