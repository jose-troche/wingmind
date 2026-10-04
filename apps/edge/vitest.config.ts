import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Edge tests run inside workerd with the e2e wrangler environment (no Workers AI
// binding, MOCK_AI=1) and a tiny neuron ceiling so the 429 paths are reachable.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        main: './src/index.ts',
        wrangler: { configPath: './wrangler.jsonc', environment: 'e2e' },
        miniflare: {
          bindings: { NEURON_CEILING: '40', SESSION_NEURON_CAP: '300', MOCK_AI: '1', TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  };
});
