import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.integration.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // Drivers share the same containers; run files one at a time.
          fileParallelism: false,
        },
      },
    ],
  },
})
