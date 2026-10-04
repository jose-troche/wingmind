import { test, expect } from './fixtures';

test('grammar command reads back and steers', async ({ page, sky }) => {
  await sky.start('fam-01');
  await sky.say('heading two seven zero');
  await expect(page.getByTestId('caption')).toHaveText('Heading two seven zero');
  await sky.step(600);                                         // 10 s
  await expect(page.getByTestId('hud').getByTestId('heading-readout')).toHaveText(/27\d/);
});

test('chaff fires on an interim transcript, before end of speech', async ({ page, sky }) => {
  await sky.start('fam-01');
  await sky.say('chaff', true);
  await sky.step(10);                                          // the sim is paused under test hooks
  await expect(page.getByTestId('cm-chaff-count')).toHaveText('59');
});

test('the final transcript after an early fire does not dispense twice', async ({ page, sky }) => {
  await sky.start('fam-01');
  await sky.say('chaff', true);
  await sky.say('chaff', false);
  await sky.step(10);
  await expect(page.getByTestId('cm-chaff-count')).toHaveText('59');
});

test('mocked LLM answers a free-form question', async ({ page, sky }) => {
  await page.route('**/api/nl/intent', r => r.fulfill({
    json: { intent: 'query.answer', answer: 'No threats on the picture.', confidence: 0.9 },
  }));
  await sky.start('fam-01');
  await sky.say('what is that contact doing');
  await expect(page.getByTestId('caption')).toHaveText('No threats on the picture.');
});

test('LLM answer with an invented number is replaced', async ({ page, sky }) => {
  await page.route('**/api/nl/intent', r => r.fulfill({
    json: { intent: 'query.answer', answer: 'Bingo in 47 minutes.', confidence: 0.9 },
  }));
  await sky.start('fam-01');
  await sky.say('how long until bingo');
  await expect(page.getByTestId('caption')).toContainText('bingo');
  await expect(page.getByTestId('caption')).not.toContainText('47');
});

test('budget exhaustion keeps the grammar alive', async ({ page, sky }) => {
  await page.route('**/api/nl/**', r => r.fulfill({ status: 429, json: { error: 'daily_budget' } }));
  await sky.start('fam-01');
  await sky.say('what is that contact doing');
  await expect(page.getByTestId('caption')).toHaveText('Unable, voice queries offline.');
  await sky.say('radar silent');
  await expect(page.getByTestId('caption')).toHaveText('Radar silent');
  await sky.step(10);
  await expect(page.getByTestId('emcon-level')).toHaveText('3');
});

test('typed commands go through the same grammar', async ({ page, sky }) => {
  await sky.start('fam-01');
  await page.getByTestId('command-input').fill('angels twenty');
  await page.getByTestId('command-input').press('Enter');
  await expect(page.getByTestId('caption')).toHaveText('Angels twenty');
});
