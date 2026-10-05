import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Unit tests import modules that read env at load time. These are harmless
    // test-only defaults; a real value in the shell (or TEST_DATABASE_URL) wins.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://unused:unused@localhost:5432/unused',
      JWT_SECRET: process.env.JWT_SECRET ?? 'unit-test-secret-unit-test-secret-1234',
    },
  },
});
