import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';

test('axe scan of the console with canvases excluded', async ({ page, sky }) => {
  await sky.start('fam-01');
  await sky.step(30);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .exclude('canvas')
    .analyze();
  const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
});

test('the start screen passes axe', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start sortie' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id)).toEqual([]);
});

test('captions present for every spoken alert', async ({ page, sky }) => {
  await sky.start('low-level-02');
  await sky.inject({ type: 'force_alert', level: 'ADVISORY', text: 'Advisory for captions.' });
  await sky.step(2);
  await sky.inject({ type: 'missile_launch', guidance: 'radar', bearingRelDeg: -120, rangeNm: 6 });
  await sky.step(6);
  await sky.say('radar silent');
  await page.waitForTimeout(300);
  const { spoken } = await sky.metrics();
  expect(spoken.length).toBeGreaterThan(1);
  const log = page.getByTestId('alert-log');
  for (const s of spoken) await expect(log).toContainText(s.text);
});
