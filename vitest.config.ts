import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'packages',
          include: ['packages/*/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'scenarios',
          include: ['tests/scenarios/**/*.test.ts'],
          environment: 'node',
          testTimeout: 240_000,
        },
      },
    ],
  },
});
