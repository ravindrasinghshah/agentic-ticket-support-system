import { defineConfig } from 'vitest/config';

// Integration tests are opt-in. `pnpm test` and `pnpm test:gate N` must be green
// with zero credentials and zero network access (Gate 1 pass criterion (b)), so the
// integration tier is excluded unless RUN_INTEGRATION=1 — set only by
// scripts/test-integration.mjs.
const runIntegration = process.env.RUN_INTEGRATION === '1';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(runIntegration ? [] : ['tests/**/integration/**']),
    ],
    environment: 'node',
    globals: false,
    testTimeout: runIntegration ? 60_000 : 10_000,
    reporters: ['default'],
  },
});
