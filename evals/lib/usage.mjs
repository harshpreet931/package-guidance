// Subscription-usage gate for Claude Code eval runs.
//
// Before each Claude session the runner calls `waitForQuota()`. A one-token Haiku probe returns the
// `rate_limit_event` that Claude Code emits in stream-json, including utilization of the 5-hour and weekly
// windows. If either is at or above the threshold, we sleep until that window resets, then check again.
// Probes are shared across concurrent workers, so N workers cause at most one probe per interval.
import { spawn } from 'node:child_process';

const THRESHOLD = Number(process.env.PG_USAGE_MAX ?? 0.8);
const RECHECK_MS = 90_000; // reuse a probe result for this long while under the threshold

let last = null; // { at, windows: [{ name, utilization, resetsAt }] }
let inflight = null;

function probe() {
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', 'Reply with OK', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--setting-sources', 'project,local', '--strict-mcp-config'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      const windows = [];
      for (const line of out.split('\n')) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type !== 'rate_limit_event') continue;
        const info = e.rate_limit_info || {};
        for (const [name, w] of Object.entries(info.unifiedWindows || {})) windows.push({ name, utilization: w.utilization ?? 0, resetsAt: w.resetsAt ?? null, status: w.status });
        if (!windows.length && info.utilization !== undefined) windows.push({ name: info.rateLimitType || 'window', utilization: info.utilization, resetsAt: info.resetsAt ?? null, status: info.status });
        if (info.status === 'rejected' && !windows.some((w) => w.utilization >= 1)) windows.push({ name: info.rateLimitType || 'window', utilization: 1, resetsAt: info.resetsAt ?? null, status: 'rejected' });
      }
      resolve({ at: Date.now(), windows });
    });
    child.on('error', () => resolve({ at: Date.now(), windows: [] }));
  });
}

async function current() {
  if (last && Date.now() - last.at < RECHECK_MS) return last;
  inflight ??= probe().then((r) => { last = r; inflight = null; return r; });
  return inflight;
}

const fmt = (w) => `${w.name} ${(w.utilization * 100).toFixed(0)}%`;

/** Resolves once every usage window is below the threshold. Logs a line whenever it pauses. */
export async function waitForQuota(log = console.log) {
  for (;;) {
    const { windows } = await current();
    if (!windows.length) return; // no signal (API-key auth, old CLI): do not block
    const over = windows.filter((w) => w.utilization >= THRESHOLD);
    if (!over.length) return;
    const resume = Math.max(...over.map((w) => (w.resetsAt ? w.resetsAt * 1000 : Date.now() + 30 * 60_000))) + 60_000;
    log(`⏸  usage ${windows.map(fmt).join(', ')} ≥ ${THRESHOLD * 100}%: pausing until ${new Date(resume).toLocaleString()}`);
    await new Promise((r) => setTimeout(r, Math.max(60_000, resume - Date.now())));
    last = null; // force a fresh probe after the reset
  }
}

export async function usageSnapshot() {
  return (await current()).windows;
}
