import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@duckcodeailabs/dql-core': resolve(__dirname, '../../packages/dql-core/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
