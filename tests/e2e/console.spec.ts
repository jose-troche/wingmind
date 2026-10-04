import { test, expect } from './fixtures';

test('shell loads with no console errors and every panel renders', async ({ page, sky }) => {
  const consoleErrors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await sky.start('fam-01');
  for (const id of ['hud', 'tsd', 'rwr', 'engine-page', 'fuel-page', 'master-warning', 'alert-log', 'agent-mesh', 'decision-trace', 'ptt', 'llm-status', 'polar', 'masking', 'threat-stack']) {
    await expect(page.getByTestId(id), id).toBeVisible();
  }
  await sky.step(30);
  await expect(page.getByTestId('heading-readout')).toHaveText(/^\d{3}$/);
  expect(consoleErrors.filter(e => !/favicon|voice\/clips/.test(e))).toEqual([]);
});

test('LLM status light follows /api/budget', async ({ page, sky }) => {
  await page.route('**/api/budget', r => r.fulfill({ json: { used: 9000, ceiling: 9000, remaining: 0, mode: 'offline' } }));
  await sky.start('fam-01');
  await expect(page.getByTestId('llm-status')).toHaveAttribute('data-state', 'offline');
});

test('LLM status light shows templates near the cap', async ({ page, sky }) => {
  await page.route('**/api/budget', r => r.fulfill({ json: { used: 7500, ceiling: 9000, remaining: 1500, mode: 'templates' } }));
  await sky.start('fam-01');
  await expect(page.getByTestId('llm-status')).toHaveAttribute('data-state', 'templates');
});

test.describe('laptop width', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test('switches displays to tabs', async ({ page, sky }) => {
    await sky.start('fam-01');
    await expect(page.getByTestId('mfd-tabs')).toBeVisible();
    await expect(page.getByTestId('tsd')).toBeVisible();
    await expect(page.getByTestId('engine-page')).toBeHidden();
    await page.getByTestId('mfd-tabs').getByRole('button', { name: 'ENGINE' }).click();
    await expect(page.getByTestId('engine-page')).toBeVisible();
    await expect(page.getByTestId('tsd')).toBeHidden();
  });
});
