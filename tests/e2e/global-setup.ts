import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeToneWav } from '../../tools/wav';

// The fake microphone needs a WAV file before Chromium launches.
export default function globalSetup(): void {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const file = join(dir, 'chaff.wav');
  if (existsSync(file)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, makeToneWav(2.0, 16_000));
}
