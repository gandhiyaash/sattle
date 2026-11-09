// The WhatsApp message for a live check (.github/workflows/live-check.yml), and whether to send it.
//
// After a publish (or a deploy run on its own) Om always hears: pass or fail, and how the publish
// itself went. The daily run only speaks up when something failed. A run started by hand always
// reports, so the wiring can be tried.
//
// Reads live-results.json (Playwright's JSON report; missing when the check couldn't run at all)
// and the environment the workflow sets. Writes `send` and `text` to $GITHUB_OUTPUT.
// Only test titles go in the message: never an address, a token or an error text.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const env = process.env;
const trigger = env.TRIGGER; // workflow_run | schedule | workflow_dispatch
const runUrl = env.RUN_URL;

function results() {
  if (!existsSync('live-results.json')) return null;
  try {
    return JSON.parse(readFileSync('live-results.json', 'utf8'));
  } catch {
    return null;
  }
}

function titles(report) {
  const failed = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) if (!spec.ok) failed.push(spec.title);
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return failed;
}

const report = results();
const stats = report?.stats;
const failed = report ? titles(report) : [];
const total = stats ? stats.expected + stats.unexpected + stats.flaky : 0;
const ran = Boolean(stats) && total > 0;
const livePassed = ran && failed.length === 0 && env.LIVE_OUTCOME === 'success';

const afterPublish = trigger === 'workflow_run';
const upstream = env.UPSTREAM_NAME || 'publish';
const upstreamOk = env.UPSTREAM_CONCLUSION === 'success';
const allOk = livePassed && (!afterPublish || upstreamOk);

const lines = [];
if (allOk) {
  lines.push('✅ *Sattle live check passed*');
} else if (afterPublish && !upstreamOk && livePassed) {
  lines.push(`🔴 *Sattle ${upstream} ${env.UPSTREAM_CONCLUSION || 'failed'}*`, 'The live check still passed.');
} else {
  lines.push('🔴 *Sattle live check FAILED*');
}
if (afterPublish) {
  lines.push(`After ${upstream} (${env.UPSTREAM_CONCLUSION || 'unknown'}) of ${env.UPSTREAM_SHA?.slice(0, 7) || 'main'}`);
} else if (trigger === 'schedule') {
  lines.push('Daily check');
} else {
  lines.push('Started by hand');
}
if (!ran) {
  lines.push("The check couldn't run (see the log).");
} else if (failed.length === 0) {
  lines.push(`${total}/${total} checks passed`);
} else {
  lines.push(`${failed.length} of ${total} checks failed:`, ...failed.map((t) => `• ${t}`));
}
lines.push('', runUrl);

const send = afterPublish || trigger === 'workflow_dispatch' || !allOk;
const out = env.GITHUB_OUTPUT;
const text = lines.join('\n');
if (out) {
  appendFileSync(out, `send=${send}\n`);
  appendFileSync(out, `ok=${allOk}\n`);
  appendFileSync(out, `text<<__LIVE_CHECK_EOF__\n${text}\n__LIVE_CHECK_EOF__\n`);
}
console.log(text);
console.log(`send=${send} ok=${allOk}`);
