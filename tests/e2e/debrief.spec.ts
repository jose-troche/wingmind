import { test, expect } from './fixtures';

test('ending a sortie saves metrics and shows the debrief', async ({ page, sky }) => {
  await sky.start('fam-01');
  await sky.step(120);
  await page.getByRole('button', { name: 'End sortie' }).click();
  const debrief = page.getByTestId('debrief');
  await expect(debrief).toBeVisible();
  await expect(debrief).toContainText('aborted');
  await expect(page.getByTestId('debrief-text')).toContainText('Try next time');
  await expect(page.getByTestId('debrief-saved')).toHaveText('Sortie saved.');
});
