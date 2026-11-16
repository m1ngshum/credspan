// Test-only Docker proxy: return the original snapshot only after the owned
// auto-removed container is authoritatively absent. No raw command errors escape.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const args = process.argv.slice(2), deadline = Date.now() + 4000;
let stage = 'snapshot', queries = 0, failureCode = 'command-failed';
const report = code => {
  // Production cleanup may make a later absence query after the hook fails.
  // Keep the first terminal evidence instead of overwriting it with that query.
  if (fs.existsSync(process.env.REPORT)) {
    const previous = JSON.parse(fs.readFileSync(process.env.REPORT, 'utf8'));
    if (['complete', 'command-failed', 'command-timeout', 'invalid-response', 'absence-pending', 'budget-exhausted'].includes(previous.code)) return;
  }
  fs.writeFileSync(process.env.REPORT, JSON.stringify({ stage, code, queries }));
};
const run = values => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) { failureCode = stage === 'absence' ? 'absence-pending' : 'budget-exhausted'; throw Error('budget'); }
  try { return execFileSync(process.env.REAL_DOCKER, values, { encoding: 'utf8', timeout: remaining, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { if (error.code === 'ETIMEDOUT') failureCode = 'command-timeout'; throw error; }
};
(async () => {
  report('pending');
  const output = run(args), id = process.env.OWNED_ID;
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error('invalid-id');
  const trigger = process.env.MODE === 'inspect'
    ? args[2] === 'ps' && args.includes('label=credspan.deployment=' + process.env.RUN_ID) && output.split('\n').includes(id)
    : args[2] === 'inspect' && args[3] === id;
  if (trigger && !fs.existsSync(process.env.MARKER)) {
    stage = 'stop'; report('pending');
    run(['--host', args[1], 'stop', '--time', '0', id]);
    stage = 'absence'; report('pending');
    while (true) {
      const ids = run(['--host', args[1], 'ps', '-aq', '--no-trunc', '--filter', 'id=' + id]).split('\n').filter(Boolean); queries++;
      if (ids.some(value => value !== id)) { failureCode = 'invalid-response'; throw Error('invalid-response'); }
      if (!ids.includes(id)) break;
      report('pending');
      if (Date.now() + 25 >= deadline) { failureCode = 'absence-pending'; throw Error('budget'); }
      await delay(25);
    }
    stage = 'marker'; report('pending');
    fs.writeFileSync(process.env.MARKER, JSON.stringify({ hookExecuted: true, exactIdAbsent: true }));
    report('complete');
  }
  process.stdout.write(output);
})().catch(() => { try { report(failureCode); } catch {} process.exitCode = 1; });
