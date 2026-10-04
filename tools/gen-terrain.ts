// Procedural terrain for each scenario (implementation 5.6). The console builds
// the same grid at load from the scenario's seed and feature list, so nothing
// needs to ship; this tool writes the raw Int16 grid and a grey-scale PGM preview
// to tools/out/ for designing scenarios.
//
//   pnpm gen:terrain              # all scenarios
//   pnpm gen:terrain low-level-02 # one

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { Scenario } from '../packages/shared/src/types';
import { Terrain } from '../packages/sim-core/src/terrain';

const dir = new URL('../apps/web/public/scenarios/', import.meta.url);
const out = new URL('./out/', import.meta.url);
mkdirSync(out, { recursive: true });

const ids = process.argv.slice(2);
const files = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json' && (ids.length === 0 || ids.includes(f.replace('.json', ''))));

for (const f of files) {
  const sc = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Scenario;
  const t0 = performance.now();
  const t = new Terrain(sc.theater.terrain);
  const ms = performance.now() - t0;
  const id = sc.theater.terrain.id;
  writeFileSync(new URL(`${id}.bin`, out), Buffer.from(t.heights.buffer));
  // preview, north up
  const header = Buffer.from(`P5\n${t.nx} ${t.ny}\n255\n`, 'ascii');
  const px = Buffer.alloc(t.nx * t.ny);
  for (let j = 0; j < t.ny; j++) for (let i = 0; i < t.nx; i++) {
    px[(t.ny - 1 - j) * t.nx + i] = Math.round((t.heights[j * t.nx + i]! / Math.max(t.maxM, 1)) * 255);
  }
  writeFileSync(new URL(`${id}.pgm`, out), Buffer.concat([header, px]));
  console.log(`${sc.id}: ${id} ${t.nx}x${t.ny} at ${t.spacing} m, max ${t.maxM} m, built in ${ms.toFixed(0)} ms (${((t.heights.byteLength) / 1e6).toFixed(1)} MB raw)`);
}
