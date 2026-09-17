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
      // Node-only Dataset authoring helpers must stay outside the browser-safe
      // core barrel. Keep these exact subpaths ahead of the broad core alias so
      // integration tests exercise their TypeScript sources rather than trying
      // to append a path to `src/index.ts`.
      {
        find: "@duckcodeailabs/dql-core/datasets/aggregate-expression.node",
        replacement: resolve(
          __dirname,
          "../../packages/dql-core/src/datasets/aggregate-expression.node.ts",
        ),
      },
      {
        find: "@duckcodeailabs/dql-core/datasets/source-authoring.node",
        replacement: resolve(
          __dirname,
          "../../packages/dql-core/src/datasets/source-authoring.node.ts",
        ),
      },
      {
        find: "@duckcodeailabs/dql-core/datasets/component-proof.node",
        replacement: resolve(
          __dirname,
          "../../packages/dql-core/src/datasets/component-proof.node.ts",
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
    // CLI integration tests start real local servers and exercise filesystem/package workflows.
    testTimeout: 30_000,
  },
});
