#!/usr/bin/env node
/**
 * Pull a deployed instance's whole store down to a local directory.
 *
 *   npx tsx scripts/backup-remote.mjs <baseUrl> [outDir]
 *   npx tsx scripts/backup-remote.mjs https://boostlingo-production.up.railway.app
 *
 * WHY THIS EXISTS: Railway's filesystem is EPHEMERAL. `DEFAULT_DATA_DIR` is the
 * repo-root `data/`, so every recording, run and `.out.wav` a deployed instance
 * wrote is destroyed on redeploy — and *mounting a persistent volume is itself
 * a redeploy*. So the order is always: BACK UP, THEN mount, THEN restore.
 *
 * A thin operational shell, like `smoke-*.mjs` and `export-results.mjs`:
 * `scripts/` is outside the vitest glob. It holds no logic worth a unit test —
 * it reads the same public GET routes the app itself reads, writes them under
 * `outDir` in the exact on-disk shape `data/` uses, and prints what it got.
 *
 * IT WRITES NOTHING TO THE REMOTE. Read-only against the deployment.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [, , rawBase, rawOut] = process.argv;
if (rawBase === undefined || rawBase.trim() === '') {
  console.error('usage: backup-remote.mjs <baseUrl> [outDir]');
  process.exit(1);
}
const base = rawBase.replace(/\/+$/, '');
const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
const out = path.resolve(rawOut ?? `backups/${stamp}`);

/** GET JSON, or exit loudly — a partial backup is worse than none. */
async function getJson(route) {
  const res = await fetch(`${base}${route}`);
  if (!res.ok) throw new Error(`GET ${route} -> HTTP ${res.status}`);
  return res.json();
}

/** GET binary; `null` when the instance has none (a 404 is not a failure). */
async function getBytes(route) {
  const res = await fetch(`${base}${route}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${route} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

try {
  mkdirSync(path.join(out, 'recordings'), { recursive: true });
  mkdirSync(path.join(out, 'runs'), { recursive: true });

  const recordings = await getJson('/api/recordings');
  const runs = await getJson('/api/runs');

  writeFileSync(path.join(out, 'recordings.json'), JSON.stringify(recordings, null, 2));
  writeFileSync(path.join(out, 'runs.json'), JSON.stringify(runs, null, 2));

  // The three append-only side stores. Absent on an older instance — record
  // `[]` rather than failing, so a restore is still faithful about what existed.
  for (const [route, file] of [
    ['/api/live-sessions', 'live-sessions.json'],
    ['/api/blind-comparisons', 'blind-comparisons.json'],
    ['/api/wer-scores', 'wer-scores.json'],
  ]) {
    let value = [];
    try {
      value = await getJson(route);
    } catch {
      console.warn(`  ! ${route} unavailable — recorded as empty`);
    }
    writeFileSync(path.join(out, file), JSON.stringify(value, null, 2));
  }

  let recAudio = 0;
  for (const recording of recordings) {
    const bytes = await getBytes(`/api/recordings/${recording.id}/audio`);
    if (bytes === null) continue;
    writeFileSync(path.join(out, 'recordings', `${recording.id}.wav`), bytes);
    recAudio += 1;
  }

  let runAudio = 0;
  for (const run of runs) {
    const bytes = await getBytes(`/api/runs/${run.id}/audio`);
    if (bytes === null) continue;
    writeFileSync(path.join(out, 'runs', `${run.id}.out.wav`), bytes);
    runAudio += 1;
  }

  console.log(`\nbacked up ${base}`);
  console.log(`  recordings   ${recordings.length}  (${recAudio} with audio)`);
  console.log(`  runs         ${runs.length}  (${runAudio} with audio)`);
  console.log(`  -> ${out}\n`);
  if (recordings.length === 0 && runs.length === 0) {
    console.warn('WARNING: the instance returned NOTHING. Check the URL before trusting this.\n');
    process.exit(1);
  }
} catch (cause) {
  console.error(`\nbackup FAILED: ${cause instanceof Error ? cause.message : String(cause)}`);
  console.error('Nothing was changed on the remote. Do not redeploy until this succeeds.\n');
  process.exit(1);
}
