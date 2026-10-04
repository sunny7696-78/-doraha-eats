import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Unit tests import modules that read env; give them safe dummies.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://postgres:devpass@localhost:5432/doraha_eats',
      JWT_SECRET: 'test-only-secret-0123456789abcdef',
    },
  },
});
