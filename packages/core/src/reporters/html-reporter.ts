import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { OrchestratorEvent, Reporter, TestResult } from '../types.js';

function esc(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : value === undefined || value === null
        ? ''
        : JSON.stringify(value);
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

/** Read a screenshot and inline it as a data URI, so the report is one file. */
async function inlineShot(artifactsDir: string, rel: unknown): Promise<string | undefined> {
  if (typeof rel !== 'string' || rel === '') {
    return undefined;
  }
  try {
    const bytes = await readFile(join(artifactsDir, rel));
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return undefined;
  }
}

function evidenceRows(evidence: Record<string, unknown>): string {
  const rows: string[] = [];
  const add = (label: string, key: string): void => {
    const v = evidence[key];
    if (v !== undefined) {
      rows.push(
        `<div class="ev"><span>${label}</span> <code>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</code></div>`,
      );
    }
  };
  add('url', 'url');
  add('selector matched', 'targetCount');
  add('related selectors', 'similarSelectors');
  add('failed API calls', 'failedApiCalls');
  add('request', 'request');
  add('status', 'status');
  add('visible text', 'excerpt');
  return rows.join('');
}

async function renderCase(result: TestResult, artifactsDir: string): Promise<string> {
  const failing = result.steps.find((s) => s.status === 'fail');
  const evidence: Record<string, unknown> = failing?.evidence ?? {};
  const shot = await inlineShot(artifactsDir, evidence['screenshot']);

  // A visual regression is the one failure you cannot read — show the three
  // images side by side instead of naming a file path nobody will open.
  const [vBase, vActual, vDiff] = await Promise.all([
    inlineShot(artifactsDir, evidence['visualBaseline']),
    inlineShot(artifactsDir, evidence['visualActual']),
    inlineShot(artifactsDir, evidence['visualDiff']),
  ]);
  const visual =
    vDiff === undefined && vActual === undefined
      ? ''
      : `<div class="visual"><div class="vhead">visual difference — ${esc(evidence['visualRatio'])}% of pixels</div><div class="vrow">
          ${vBase === undefined ? '' : `<figure><img src="${vBase}" alt="baseline" /><figcaption>baseline</figcaption></figure>`}
          ${vActual === undefined ? '' : `<figure><img src="${vActual}" alt="actual" /><figcaption>actual</figcaption></figure>`}
          ${vDiff === undefined ? '' : `<figure><img src="${vDiff}" alt="difference" /><figcaption>diff</figcaption></figure>`}
        </div></div>`;

  const steps = result.steps
    .map((s) => {
      const mark = s.status === 'pass' ? '✓' : s.status === 'flaky' ? '~' : '✕';
      const detail = s.error?.message ?? s.output ?? '';
      return `<div class="step ${s.status}"><span class="mk">${mark}</span><span class="ac">${esc(s.action ?? s.stepId ?? '')}</span><span class="dt">${esc(detail.split('\n')[0])}</span></div>`;
    })
    .join('');

  return `<details class="case ${result.status}" ${result.status === 'fail' ? 'open' : ''}>
    <summary><span class="badge ${result.status}">${result.status.toUpperCase()}</span> ${esc(result.testCaseName)} <span class="ms">${String(result.durationMs)}ms</span></summary>
    <div class="steps">${steps}</div>
    ${Object.keys(evidence).length > 0 ? `<div class="evidence">${evidenceRows(evidence)}</div>` : ''}
    ${visual}
    ${shot !== undefined && visual === '' ? `<img class="shot" loading="lazy" alt="page when the step failed" src="${shot}" />` : ''}
  </details>`;
}

/**
 * A single-file HTML report: the run summary, every test's steps, and — for a
 * failure — its evidence and screenshot inlined as a data URI, so the whole
 * thing is one file you can attach to a ticket or open anywhere. Screenshots
 * come from the artifacts directory; pass it, or they are simply omitted.
 *
 * @public
 */
export function createHtmlReporter(outputPath: string, artifactsDir = '.artifacts'): Reporter {
  const collected: TestResult[] = [];

  return {
    kind: 'reporter',
    name: 'html',
    type: 'html',
    onEvent: async (event: OrchestratorEvent): Promise<void> => {
      if (event.type === 'test:end') {
        collected.push(event.result);
        return;
      }
      if (event.type !== 'run:end') {
        return;
      }
      const results = (event.results ?? []).length > 0 ? [...event.results] : collected;
      const passed = results.filter((r) => r.status === 'pass').length;
      const failed = results.filter((r) => r.status === 'fail').length;
      const flaky = results.filter((r) => r.status === 'flaky').length;
      const cases = (await Promise.all(results.map((r) => renderCase(r, artifactsDir)))).join('\n');

      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Test report</title>
<style>
  :root { color-scheme: dark; --bg:#0b0e14; --panel:#141926; --line:#232c3d; --ink:#e8ecf4; --dim:#8794ab;
    --pass:#4ade80; --fail:#f87171; --flaky:#fbbf24; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink);
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; padding:2rem 1rem 4rem; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { font-size:1.3rem; margin:0 0 1rem; }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:.6rem; margin-bottom:1.5rem; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.8rem; text-align:center; }
  .stat .n { font-size:1.6rem; font-weight:700; font-variant-numeric:tabular-nums; }
  .stat.pass .n{color:var(--pass);} .stat.fail .n{color:var(--fail);} .stat.flaky .n{color:var(--flaky);}
  .stat .k { font-size:.65rem; color:var(--dim); text-transform:uppercase; letter-spacing:.1em; }
  .case { background:var(--panel); border:1px solid var(--line); border-radius:12px; margin-bottom:.7rem; overflow:hidden; }
  summary { cursor:pointer; padding:.85rem 1.1rem; display:flex; align-items:center; gap:.7rem; font-weight:600; }
  summary .ms { margin-left:auto; color:var(--dim); font-size:.8rem; font-weight:400; font-variant-numeric:tabular-nums; }
  .badge { font-family:ui-monospace,monospace; font-size:.66rem; font-weight:700; padding:.15rem .5rem; border-radius:5px; }
  .badge.pass{background:#123524;color:var(--pass);} .badge.fail{background:#3a1620;color:var(--fail);} .badge.flaky{background:#33260f;color:var(--flaky);}
  .steps { padding:0 1.1rem .6rem; }
  .step { display:flex; gap:.6rem; padding:.25rem 0; font-size:.85rem; border-top:1px solid #1a2130; }
  .step .mk { width:1rem; } .step.pass .mk{color:var(--pass);} .step.fail .mk{color:var(--fail);} .step.flaky .mk{color:var(--flaky);}
  .step .ac { font-family:ui-monospace,monospace; color:var(--dim); min-width:130px; }
  .step .dt { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .step.fail .dt { color:var(--fail); }
  .evidence { padding:.5rem 1.1rem; border-top:1px solid #1a2130; font-size:.82rem; }
  .ev { display:flex; gap:.5rem; padding:.12rem 0; } .ev span { color:var(--dim); min-width:130px; }
  .ev code { color:#cfe0ff; font-family:ui-monospace,monospace; }
  .shot { display:block; max-width:100%; margin:.6rem 1.1rem 1.1rem; border:1px solid var(--line); border-radius:8px; }
  .visual { padding:.6rem 1.1rem 1.1rem; border-top:1px solid #1a2130; }
  .vhead { font-size:.78rem; color:var(--dim); margin-bottom:.5rem; }
  .vrow { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:.6rem; }
  .vrow figure { margin:0; }
  .vrow img { width:100%; border:1px solid var(--line); border-radius:6px; display:block; }
  .vrow figcaption { font-size:.7rem; color:var(--dim); text-align:center; margin-top:.25rem;
    text-transform:uppercase; letter-spacing:.08em; }
  .foot { color:var(--dim); font-size:.78rem; margin-top:2rem; }
</style></head><body><div class="wrap">
  <h1>Test report</h1>
  <div class="stats">
    <div class="stat"><div class="n">${String(results.length)}</div><div class="k">total</div></div>
    <div class="stat pass"><div class="n">${String(passed)}</div><div class="k">passed</div></div>
    <div class="stat fail"><div class="n">${String(failed)}</div><div class="k">failed</div></div>
    <div class="stat flaky"><div class="n">${String(flaky)}</div><div class="k">flaky</div></div>
  </div>
  ${cases}
  <div class="foot">${String(event.totalDurationMs)}ms · generated by test-orchestrator</div>
</div></body></html>
`;
      await writeFile(outputPath, html, 'utf8');
    },
  };
}
