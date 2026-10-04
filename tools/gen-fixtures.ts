// Test fixtures: the fake-microphone clip Playwright feeds to Chromium.
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeToneWav } from './wav';

const dir = new URL('../tests/e2e/fixtures/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('chaff.wav', dir), makeToneWav(2.0, 16_000));
console.log('wrote tests/e2e/fixtures/chaff.wav');
