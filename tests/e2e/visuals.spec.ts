import { test, expect } from './fixtures';

test('agent mesh pulses on a missile event', async ({ page, sky }) => {
  await sky.start('low-level-02');
  await sky.inject({ type: 'missile_launch', guidance: 'radar', bearingRelDeg: -120, rangeNm: 6 });
  await sky.step(6);
  // the pulse fades in about 1.5 s of wall time, so read both attributes in one go
  await expect.poll(() => page.getByTestId('agent-mesh').evaluate(c => {
    const d = (c as HTMLCanvasElement).dataset;
    return d.maxPriority === '0' && Number(d.pulses) > 3;
  })).toBe(true);
});

test('decision trace shows SIG suppressed', async ({ page, sky }) => {
  await sky.start('low-level-02');
  await sky.inject({ type: 'missile_launch', guidance: 'radar', bearingRelDeg: -120, rangeNm: 6 });
  await sky.step(6);
  await expect(page.getByTestId('decision-trace')).toContainText('MAWS won');
  await expect(page.getByTestId('decision-trace')).toContainText('SIG suppressed');
});

test('polar needle moves with heading', async ({ page, sky }) => {
  await sky.start('sam-belt-01');
  await sky.step(15);
  const needle = page.getByTestId('polar-needle').first();
  await expect(needle).toBeVisible();
  const before = Number(await needle.getAttribute('data-aspect'));
  await sky.inject({ type: 'teleport', headingDeg: 150 });
  await sky.step(20);
  await expect.poll(async () => Number(await needle.getAttribute('data-aspect'))).not.toBe(before);
});

test('masking line flips color when the aircraft climbs out of the terrain shadow', async ({ page, sky }) => {
  await sky.start('sam-belt-01');
  await sky.step(15);
  await expect(page.getByTestId('masking-line')).toHaveAttribute('data-state', 'masked');
  await sky.inject({ type: 'teleport', altFt: 35000 });
  await sky.step(2);
  await expect(page.getByTestId('masking-line')).toHaveAttribute('data-state', 'clear');
});

test('explain card opens from a badge and from "explain that"', async ({ page, sky }) => {
  await sky.start('low-level-02');
  await page.getByRole('button', { name: 'Explain agent mesh' }).click();
  await expect(page.getByTestId('explain-card')).toContainText('Agent mesh');
  await page.getByTestId('explain-card').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('explain-card')).toBeHidden();
  await sky.inject({ type: 'missile_launch', guidance: 'radar', bearingRelDeg: -120, rangeNm: 6 });
  await sky.step(6);
  await sky.say('explain that');
  await expect(page.getByTestId('explain-card')).toContainText('Missile defense');
});
