import { test, expect } from './fixtures';

test('HUD, engine and fuel values match the sim after a fixed number of frames', async ({ page, sky }) => {
  await sky.start('fam-01', 7);
  await sky.step(120);
  const s = await sky.state();
  expect(s).not.toBeNull();
  const own = s!.own;
  await expect(page.getByTestId('heading-readout')).toHaveText(String(Math.round(own.headingDeg) % 360).padStart(3, '0'));
  await expect(page.getByTestId('hud-kcas')).toHaveText(String(Math.round(own.kcas)));
  await expect(page.getByTestId('hud-alt')).toHaveText(String(Math.round(own.altFt / 10) * 10));
  const left = own.engines[0]!;
  await expect(page.getByTestId('eng-n2-left')).toHaveText(Number(left.n2).toFixed(0));
  await expect(page.getByTestId('fuel-total')).toHaveText(`TOTAL ${Math.round(s!.fuel.totalLb / 10) * 10} LB`);
});

test('throttle to military shows on the engine page', async ({ page, sky }) => {
  await sky.start('fam-01', 7);
  await sky.inject({ type: 'set_throttle', value: 0.85 });
  await sky.step(300);
  await expect(page.getByTestId('eng-mode-left')).toHaveText(/MILITARY/);
  const n2 = Number(await page.getByTestId('eng-n2-right').textContent());
  expect(n2).toBeGreaterThan(95);
});

test('engine page baseline at military power @visual', async ({ page, sky }) => {
  await sky.start('fam-01', 7);
  await sky.inject({ type: 'set_throttle', value: 0.85 });
  await sky.step(300);
  await page.waitForTimeout(250);
  await expect(page.getByTestId('engine-page')).toHaveScreenshot('engine-mil.png');
});

test('fuel page baseline @visual', async ({ page, sky }) => {
  await sky.start('fam-01', 7);
  await sky.step(60);
  await page.waitForTimeout(250);
  await expect(page.getByTestId('fuel-page')).toHaveScreenshot('fuel.png');
});

test('HUD baseline with the 3D scene masked @visual', async ({ page, sky }) => {
  await sky.start('fam-01', 7);
  await sky.step(60);
  await page.waitForTimeout(250);
  await expect(page.getByTestId('hud')).toHaveScreenshot('hud.png', { mask: [page.getByTestId('scene')] });
});

test('warning receiver baseline with a guidance emitter @visual', async ({ page, sky }) => {
  await sky.start('sam-belt-01', 7);
  await sky.inject({ type: 'missile_launch', guidance: 'radar', bearingRelDeg: 60, rangeNm: 20 });
  await sky.step(6);
  await page.waitForTimeout(250);
  await expect(page.getByTestId('rwr')).toHaveScreenshot('rwr.png', { maxDiffPixelRatio: 0.03 });
});

test('signature polar plot baseline @visual', async ({ page, sky }) => {
  await sky.start('sam-belt-01', 7);
  await sky.step(30);
  await page.waitForTimeout(250);
  await expect(page.getByTestId('polar')).toHaveScreenshot('polar.png');
});
