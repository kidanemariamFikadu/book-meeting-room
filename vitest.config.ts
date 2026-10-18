import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Integration tests share one PostgreSQL database, so they must not run
    // concurrently with each other.
    fileParallelism: false,
    sequence: { concurrent: false },
    include: ['server/tests/**/*.test.ts', 'shared/tests/**/*.test.ts'],
    setupFiles: ['server/tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      // The booking rules are not a place for untested branches; the view layer
      // is less critical (docs/10-testing.md gate 8).
      include: ['shared/src/**', 'server/src/services/**', 'server/src/domain/**'],
      reporter: ['text', 'html'],
    },
  },
})
