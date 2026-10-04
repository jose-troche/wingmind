import { client, recordFps } from '../controller';
import { ui } from '../store';
import { MaskingProfile } from '../visuals/Masking';
import { MeshView } from '../visuals/Mesh';
import { PolarPlot } from '../visuals/Polar';
import { EnginePage } from './Engine';
import { FuelPage } from './Fuel';
import { Hud } from './Hud';
import type { InputManager } from './input';
import { Rwr } from './Rwr';
import { Scene } from './Scene';
import { Tsd } from './Tsd';

// One requestAnimationFrame loop draws everything from the latest snapshot,
// never through React state (implementation 8). If the frame budget is missed
// for 2 s, scene resolution drops first, then instrument refresh to 20 Hz.

export interface Instruments {
  scene: Scene; hud: Hud; tsd: Tsd; rwr: Rwr; engine: EnginePage; fuel: FuelPage;
  mesh: MeshView; polar: PolarPlot; masking: MaskingProfile;
  defensive: { chaff: HTMLElement; flares: HTMLElement; emcon: HTMLElement; mode: HTMLElement } | null;
  clock: HTMLElement | null;
}

export function startLoop(ins: Instruments, input: InputManager): () => void {
  let raf = 0;
  let last = performance.now();
  let instrumentHz = 30;
  let slowSince: number | null = null;
  let degraded = 0;
  const due = new Map<string, number>();
  const every = (key: string, hz: number, now: number): boolean => {
    const t = due.get(key) ?? 0;
    if (now < t) return false;
    due.set(key, now + 1000 / hz);
    return true;
  };
  let terrainFor: unknown = null;
  let fpsAcc = 0, fpsN = 0, fpsT = performance.now();

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = now - last;
    last = now;
    fpsAcc += dt; fpsN++;
    if (now - fpsT > 1000) { recordFps(1000 / (fpsAcc / fpsN)); fpsAcc = 0; fpsN = 0; fpsT = now; }
    // frame budget governor
    if (dt > 20) { slowSince ??= now; } else slowSince = null;
    if (slowSince !== null && now - slowSince > 2000) {
      if (degraded === 0) { ins.scene.pixelRatio = Math.max(0.5, ins.scene.pixelRatio * 0.6); degraded = 1; }
      else if (degraded === 1) { instrumentHz = 20; degraded = 2; }
      slowSince = null;
    }
    input.poll();
    const f = client.frame();
    if (!f) return;
    if (client.terrain && client.scenario && terrainFor !== client.terrain) { ins.scene.setTerrain(client.terrain, client.scenario); terrainFor = client.terrain; }
    const board = client.board;
    const s = ui.get();
    ins.scene.draw(f);
    ins.hud.draw(f, board, s.masterWarning, now);
    if (every('inst', instrumentHz, now)) {
      ins.tsd.draw(f, board, client.scenario, s.tsdRangeNm, s.showRings);
      ins.rwr.draw(f, now);
    }
    if (every('pages', 10, now)) {
      ins.engine.draw(f);
      ins.fuel.draw(f);
      ins.polar.draw(board);
      const edges = client.takeMeshEdges();
      if (edges.length) ins.mesh.ingest(edges, now);
      ins.mesh.draw();
      if (ins.defensive) {
        ins.defensive.chaff.textContent = String(f.own.cm.chaff);
        ins.defensive.flares.textContent = String(f.own.cm.flares);
        ins.defensive.emcon.textContent = String(f.own.emcon);
        ins.defensive.mode.textContent = (board?.ew.mode ?? 'semi').toUpperCase();
      }
      if (ins.clock) {
        const sec = Math.floor(f.tMs / 1000);
        ins.clock.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
      }
    }
    if (every('mask', 5, now)) ins.masking.draw(f, board, client.terrain);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
