import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@avorant/shared/node': fileURLToPath(new URL('../shared/src/node.ts', import.meta.url)),
      '@avorant/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@avorant/server-core': fileURLToPath(new URL('../server-core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
