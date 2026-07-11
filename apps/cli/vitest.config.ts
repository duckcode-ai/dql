import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@duckcodeailabs/dql-core/format",
        replacement: resolve(
          __dirname,
          "../../packages/dql-core/src/format/index.ts",
        ),
      },
      {
        find: "@duckcodeailabs/dql-core/lineage",
        replacement: resolve(
          __dirname,
          "../../packages/dql-core/src/lineage/index.ts",
        ),
      },
      {
        find: "@duckcodeailabs/dql-core/artifacts",
        replacement: resolve(
          __dirname,
          "../../packages/dql-core/src/artifacts/index.ts",
        ),
      },
      {
        find: "@duckcodeailabs/dql-core",
        replacement: resolve(__dirname, "../../packages/dql-core/src/index.ts"),
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
