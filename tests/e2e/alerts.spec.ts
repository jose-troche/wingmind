import { test, expect } from './fixtures';

test('missile launch raises a warning, a caption and a break-right directive', async ({ page, sky }) => {
  await sky.start('low-level-02');
  await sky.inject({ type: 'missile_launch', guidance: 'radar', bearingRelDeg: -120, rangeNm: 6 });
  await sky.step(6);                                           // 100 ms of sim time

  await expect(page.getByTestId('master-warning')).toHaveAttribute('data-state', 'on');
  await expect(page.getByTestId('caption')).toHaveText(/Missile, left eight, six miles\. Break right, chaff\./);

  const { directives } = await sky.metrics();
  const heading = directives.find(d => d.axis === 'heading' && (d.value as { mode?: string } | null)?.mode === 'break');
  expect(heading?.why[0]).toContain('MAWS');
  expect(heading?.why.join(' ')).toContain('SIG suppressed');
});

test('a warning cuts off an advisory mid-sentence', async ({ page, sky }) => {
  await sky.start('sam-belt-01');
  await sky.inject({ type: 'force_alert', level: 'ADVISORY', text: 'Weather ahead, twenty miles.' });
  await sky.step(2);
  await sky.inject({ type: 'missile_launch', guidance: 'ir', bearingRelDeg: 110, rangeNm: 1.5 });
  await sky.step(6);
  await expect(page.getByTestId('caption')).toHaveText(/^Missile, right four/);
  await expect(page.getByTestId('alert-log').getByText('Weather ahead')).toHaveAttribute('data-status', 'requeued');
});

test('duplicate alerts are suppressed', async ({ page, sky }) => {
  await sky.start('fam-01');
  await sky.inject({ type: 'force_alert', level: 'CAUTION', text: 'Hydraulic pressure low.' });
  await sky.step(2);
  await sky.inject({ type: 'force_alert', level: 'CAUTION', text: 'Hydraulic pressure low.' });
  await sky.step(2);
  const rows = page.getByTestId('alert-log').locator('li', { hasText: 'Hydraulic pressure low.' });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-status', 'suppressed');
  const { spoken } = await sky.metrics();
  expect(spoken.filter(s => s.text === 'Hydraulic pressure low.')).toHaveLength(1);
});

test('"copy" stops a repeating warning', async ({ page, sky }) => {
  await sky.start('fam-01');
  await sky.inject({ type: 'force_alert', level: 'WARNING', text: 'Test warning.' });
  await sky.step(2);
  await expect(page.getByTestId('master-warning')).toHaveAttribute('data-state', 'on');
  await sky.say('copy');
  await expect(page.getByTestId('master-warning')).toHaveAttribute('data-state', 'off');
  await sky.step(60 * 10);                                     // past every repeat interval
  const { spoken } = await sky.metrics();
  expect(spoken.filter(s => s.text === 'Test warning.')).toHaveLength(1);
});
