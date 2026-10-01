/* global OfflineAudioContext, AudioContext -- these run in the browser page */
// Measurement for ADR 0002: the cost of the same effect chain built from
// WebAudio nodes (compressor, 10-band EQ, cab convolver) in Chromium and
// WebKit, rendered offline. Run with `node scripts/audio-bench-web.mjs`.
import { chromium, webkit } from "@playwright/test";

const SECONDS = 20;

async function measure(page, tracks) {
  return page.evaluate(
    async ({ tracks, seconds }) => {
      const rate = 48_000;
      const ctx = new OfflineAudioContext(2, rate * seconds, rate);
      const ir = ctx.createBuffer(1, 2_400, rate); // 50 ms cabinet
      const data = ir.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / 300);
      for (let t = 0; t < tracks; t++) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = 82 + t * 7;
        let node = osc;
        const comp = ctx.createDynamicsCompressor();
        node.connect(comp);
        node = comp;
        for (const freq of [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]) {
          const band = ctx.createBiquadFilter();
          band.type = "peaking";
          band.frequency.value = freq;
          band.gain.value = 3;
          node.connect(band);
          node = band;
        }
        const cab = ctx.createConvolver();
        cab.buffer = ir;
        node.connect(cab);
        cab.connect(ctx.destination);
        osc.start();
      }
      const started = performance.now();
      await ctx.startRendering();
      return (performance.now() - started) / 1000 / seconds;
    },
    { tracks, seconds: SECONDS },
  );
}

for (const [name, type] of [
  ["Chromium", chromium],
  ["WebKit", webkit],
]) {
  const browser = await type.launch();
  const page = await browser.newPage();
  await page.goto("about:blank");
  for (const tracks of [1, 8, 16]) {
    const factor = await measure(page, tracks);
    console.log(`${name}: ${tracks} track(s) → ${(factor * 100).toFixed(2)}% of real time`);
  }
  const latency = await page.evaluate(() => {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const info = { base: ctx.baseLatency, output: ctx.outputLatency };
    void ctx.close();
    return info;
  });
  console.log(
    `${name}: baseLatency ${(latency.base * 1000).toFixed(1)} ms, outputLatency ${((latency.output ?? 0) * 1000).toFixed(1)} ms (headless)`,
  );
  await browser.close();
}
