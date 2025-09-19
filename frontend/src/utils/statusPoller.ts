// statusPoller.ts (or plain JS)
// Minimal helpers for progress + ETA that won’t “stick” at 45%

let lastProgress = 0;
let lastTick = performance.now();
let emaSpeed = 0; // exponential moving average of % per ms
let flatTicks = 0;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function humanizeMs(ms: number) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

export async function pollStatus(
  rawmodelId: number,
  onUpdate: (data: { progress: number, stage: string, etaText: string, indeterminate: boolean }) => void
) {
  let delay = 1000;

  lastProgress = 0;
  lastTick = performance.now();
  emaSpeed = 0;
  flatTicks = 0;

  while (true) {
    const t0 = performance.now();
    const s = await fetch(`/api/status/${rawmodelId}`).then(r => r.json()).catch(() => null);
    const t1 = performance.now();

    if (!s) {
      onUpdate({ progress: lastProgress, stage: 'unknown', etaText: '…', indeterminate: true });
      await sleep(delay = Math.min(8000, Math.floor(delay * 1.5)));
      continue;
    }

    const p = Math.max(0, Math.min(100, Number(s.progress || 0)));
    const stage = String(s.stage || 'unknown');

    const dt = Math.max(1, t1 - lastTick);
    const dp = Math.max(0, p - lastProgress);

    if (dp === 0) flatTicks++; else flatTicks = 0;

    const instSpeed = dp / dt;                   // % per ms
    emaSpeed = emaSpeed ? (0.7 * emaSpeed + 0.3 * instSpeed) : instSpeed;

    let etaText = 'Calculating…';
    if (emaSpeed > 0 && p < 100) {
      const remainingPct = 100 - p;
      const etaMs = remainingPct / emaSpeed;
      const safeEta = Math.min(45 * 60 * 1000, Math.max(5 * 1000, etaMs));
      etaText = humanizeMs(safeEta);
    }

    const indeterminate = flatTicks >= 6 && p < 100;

    onUpdate({ progress: p, stage, etaText, indeterminate });

    lastProgress = p;
    lastTick = t1;

    if (stage === 'ready' || p >= 100) break;

    await sleep(delay);
    delay = Math.min(8000, Math.floor(delay * 1.5));
  }
}
