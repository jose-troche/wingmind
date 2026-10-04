import { test, expect } from './fixtures';

test('fake microphone clip posts to /api/stt and the transcript flows through the grammar', async ({ page, sky }) => {
  let posted = 0;
  await page.route('**/api/stt**', async r => {
    posted++;
    expect(r.request().method()).toBe('POST');
    await r.fulfill({ json: { text: 'chaff' } });
  });
  await sky.start('fam-01', 42, '/?stt=server');
  await expect(page.getByTestId('ptt')).toBeVisible();
  await page.keyboard.down('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.up('Space');
  await expect.poll(() => posted).toBe(1);
  // the sim is paused under test hooks: advance it until the dispense lands
  await expect.poll(async () => { await sky.step(10); return page.getByTestId('cm-chaff-count').textContent(); }).toBe('59');
});
