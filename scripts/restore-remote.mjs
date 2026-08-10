#!/usr/bin/env node
/**
 * Push a backup back into a deployed instance, through the app's OWN write path.
 *
 *   npx tsx scripts/restore-remote.mjs <baseUrl> <backupDir>
 *
 * Restores by POSTing to the same routes the app uses, so the ledger, the
 * per-entity files and the audio store are rebuilt consistently. Hand-placing
 * files into `data/` would leave `ledger.jsonl` out of step with them.
 *
 * IDEMPOTENT ENOUGH TO RERUN: an id the instance already holds is skipped
 * rather than duplicated, and every skip is printed. Append-only stores mean a
 * blind re-POST would otherwise double every figure on the Results screen.
 *
 * A thin operational shell, like `backup-remote.mjs`. Run the backup FIRST and
 * check its counts; this script trusts the directory it is given.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const [, , rawBase, rawDir] = process.argv;
if (rawBase === undefined || rawDir === undefined) {
  console.error('usage: restore-remote.mjs <baseUrl> <backupDir>');
  process.exit(1);
}
const base = rawBase.replace(/\/+$/, '');
const dir = path.resolve(rawDir);

const readJson = (file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
const b64 = (file) => (existsSync(file) ? readFileSync(file).toString('base64') : undefined);

async function post(route, body) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${route} -> HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

try {
  const recordings = readJson('recordings.json');
  const runs = readJson('runs.json');

  // What the target already holds — so a rerun tops up rather than doubling.
  const haveRec = new Set(
    (await fetch(`${base}/api/recordings`).then((r) => r.json())).map((x) => x.id),
  );
  const haveRun = new Set((await fetch(`${base}/api/runs`).then((r) => r.json())).map((x) => x.id));

  let recDone = 0;
  let recSkip = 0;
  for (const recording of recordings) {
    if (haveRec.has(recording.id)) {
      recSkip += 1;
      continue;
    }
    const audioBase64 = b64(path.join(dir, 'recordings', `${recording.id}.wav`));
    if (audioBase64 === undefined) {
      console.warn(`  ! ${recording.id} has no audio in the backup — skipped`);
      continue;
    }
    await post('/api/recordings', { ...recording, audioBase64 });
    recDone += 1;
  }

  let runDone = 0;
  let runSkip = 0;
  let runAudio = 0;
  for (const run of runs) {
    if (haveRun.has(run.id)) {
      runSkip += 1;
      continue;
    }
    // The Run is stored verbatim, so every stamp 061/059/070 wrote survives.
    await post('/api/runs', run);
    runDone += 1;
    const audioBase64 = b64(path.join(dir, 'runs', `${run.id}.out.wav`));
    if (audioBase64 !== undefined) {
      await post(`/api/runs/${run.id}/audio`, { audioBase64 });
      runAudio += 1;
    }
  }

  // Side stores, best effort — a restore that lands the corpus and the runs is
  // already the valuable part, and these must never abort it.
  for (const [file, route] of [
    ['live-sessions.json', '/api/live-sessions'],
    ['blind-comparisons.json', '/api/blind-comparisons'],
    ['wer-scores.json', '/api/wer-scores'],
  ]) {
    if (!existsSync(path.join(dir, file))) continue;
    for (const entry of readJson(file)) {
      try {
        await post(route, entry);
      } catch {
        /* already present, or an older instance without the route */
      }
    }
  }

  console.log(`\nrestored into ${base}`);
  console.log(`  recordings   ${recDone} written, ${recSkip} already present`);
  console.log(`  runs         ${runDone} written (${runAudio} with audio), ${runSkip} already present\n`);
} catch (cause) {
  console.error(`\nrestore FAILED: ${cause instanceof Error ? cause.message : String(cause)}`);
  console.error('Rerun it — ids already written are skipped, so nothing doubles.\n');
  process.exit(1);
}
