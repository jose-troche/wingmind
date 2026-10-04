import { test, expect } from './fixtures';

// Gate 0 (implementation 10.3): 50 injected launches in the low-level scenario;
// 95th-percentile event-to-audio latency at 150 ms or less, and the correct
// beam turn away from rising terrain in every run.

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};

test.describe('@gate', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(10 * 60_000);

  test('50 injected launches: p95 event-to-audio latency <= 150 ms, correct directive every time @gate', async ({ page, sky }) => {
    await sky.start('low-level-02', 1);
    const latencies: number[] = [];
    const sides: string[] = [];
    for (let i = 0; i < 50; i++) {
      await page.evaluate(seed => window.__sky.loadScenario('low-level-02', seed), 100 + i);
      await page.evaluate(() => window.__sky.pause());
      await sky.inject({ type: 'missile_launch', guidance: 'radar', bearingRelDeg: -120, rangeNm: 6 });
      await sky.step(6);
      await expect.poll(async () => (await sky.metrics()).alertLatencyMs.length, { timeout: 5000 }).toBeGreaterThan(0);
      const m = await sky.metrics();
      latencies.push(m.alertLatencyMs[0]!);
      const brk = m.directives.find(d => d.axis === 'heading' && (d.value as { mode?: string } | null)?.mode === 'break');
      sides.push(String((brk?.value as { side?: string } | undefined)?.side));
    }
    const p95 = percentile(latencies, 95);
    test.info().annotations.push({ type: 'p95-latency-ms', description: p95.toFixed(1) });
    console.log(`Gate 0: p50 ${percentile(latencies, 50).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms over ${latencies.length} launches`);
    expect(p95).toBeLessThanOrEqual(150);
    expect(sides.every(s => s === 'right'), `break sides: ${sides.join(',')}`).toBe(true);
  });

  test('frame rate holds while flying in real time @gate', async ({ page, sky }) => {
    await sky.start('sam-belt-01', 3);
    await sky.resume();
    await page.waitForTimeout(12_000);
    const { fps } = await sky.metrics();
    const recent = fps.slice(-10);
    const median = percentile(recent, 50);
    test.info().annotations.push({ type: 'median-fps', description: median.toFixed(1) });
    // 60 fps median is the laptop target; headless software GL is judged at 30
    expect(median).toBeGreaterThanOrEqual(process.env.GATE_FPS ? Number(process.env.GATE_FPS) : 30);
    expect(Math.min(...recent)).toBeGreaterThan(10);
  });
});
