import { defineConfig, devices } from '@playwright/test';

// Playwright UI tests (implementation 10.4): the real console in Chromium against
// `wrangler dev` (e2e environment: MOCK_AI=1, no Workers AI binding), with the
// simulation seeded and steppable through window.__sky. Local tool first:
// nothing in the deploy pipeline waits on these.

const chromium = {
  ...devices['Desktop Chrome'],
  viewport: { width: 1600, height: 900 },
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--use-file-for-fake-audio-capture=tests/e2e/fixtures/chaff.wav',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--enable-unsafe-swiftshader',
    ],
  },
};

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CI ? { workers: 2 } : {}),
  reporter: [['html', { open: 'never', outputFolder: '../../playwright-report' }], ['list']],
  outputDir: '../../test-results',
  globalSetup: './global-setup.ts',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:8787',   // set BASE_URL for the fast loop against Vite
    trace: 'retain-on-failure',
    viewport: { width: 1600, height: 900 },
  },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  projects: [
    { name: 'chromium', use: chromium, grepInvert: /@gate/ },
    // the gate measures latency and frame rate, so it runs alone after everything else
    { name: 'gate', use: chromium, grep: /@gate/, dependencies: ['chromium'] },
    ...(process.env.FIREFOX === '1'
      ? [{ name: 'firefox-smoke', use: { ...devices['Desktop Firefox'], viewport: { width: 1600, height: 900 } }, testMatch: /console|alerts/ }]
      : []),
  ],
  webServer: {
    command:
      'VITE_TEST_HOOKS=1 pnpm --filter web build && pnpm --filter edge exec wrangler d1 migrations apply wingmind --local --env e2e && pnpm --filter edge exec wrangler dev --port 8787 --env e2e',
    url: 'http://localhost:8787/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    cwd: '../..',
  },
});
