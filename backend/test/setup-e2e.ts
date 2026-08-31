/**
 * e2e tests run on the host against the published Docker ports.
 * Explicit environment variables always win (existing env takes precedence
 * over .env files in @nestjs/config), so default the dependency hosts to
 * localhost here; in Docker the compose environment provides real values.
 */
process.env.DATABASE_HOST ??= 'localhost';
process.env.REDIS_HOST ??= 'localhost';
process.env.DATABASE_PORT ??= '5432';
process.env.REDIS_PORT ??= '6379';
process.env.DATABASE_NAME ??= 'flash_sale';
process.env.DATABASE_USER ??= 'flash_sale';
process.env.DATABASE_PASSWORD ??= 'flash_sale_dev';
// e2e tests use a dedicated database so they never touch development data.
// database.e2e-spec.ts creates and migrates it before running.
process.env.DATABASE_URL ??=
  'postgresql://flash_sale:flash_sale_dev@localhost:5432/flash_sale_test';
