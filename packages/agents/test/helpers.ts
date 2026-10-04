import { readFileSync } from 'node:fs';
import type { Scenario } from '@wingmind/shared';

export const loadScenario = (id: string): Scenario =>
  JSON.parse(readFileSync(new URL(`../../../apps/web/public/scenarios/${id}.json`, import.meta.url), 'utf8')) as Scenario;
