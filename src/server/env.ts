/**
 * Ticket 037 — load `.env` into the server process.
 *
 * ============================ API DESIGN (normative) =======================
 * loadServerEnv(file) -> Set<string>   the names it actually set
 *
 * WHY THIS EXISTS. Nothing in this repo ever loaded `.env`: there is no
 * `dotenv` dependency, no `--env-file` flag in any npm script, and no
 * `process.loadEnvFile()` call. So `process.env.OPENAI_API_KEY` was undefined
 * on every normal start, `POST /api/realtime-token` answered 500, and a Live
 * session reached "connected · listening" before failing opaquely — the
 * product's headline feature, dead on arrival, under a fully green suite.
 * The suite could not have caught it: every test runs on fixtures by policy,
 * so none reads a real key.
 *
 * THE REAL ENVIRONMENT ALWAYS WINS. A value already present in `process.env`
 * is never overwritten. Deployment sets real environment variables; `.env` is
 * a developer convenience, and a file that could clobber a deployed secret
 * would be a far worse bug than the one this fixes.
 *
 * A MISSING FILE IS NOT AN ERROR. A deployed server legitimately has real env
 * vars and no `.env` at all, so absence is a normal state, not a failure. A
 * malformed line is skipped rather than crashing startup — the same tolerant
 * discipline the JSONL reader uses.
 *
 * IT RETURNS NAMES, NEVER VALUES, so a caller can log which keys are present
 * without ever putting a secret in a log line.
 *
 * No new dependency: this is a hand-rolled parser rather than
 * `process.loadEnvFile`, because that built-in throws on a missing file and
 * gives no way to report which names were set.
 * ==========================================================================
 */
/**
 * Ticket 038 — the startup diagnostic, as a PURE FUNCTION.
 *
 * ============================ API DESIGN (normative) =======================
 *   PROVIDER_KEY_NAMES                      the names the server cares about
 *   describeProviderKeys(loaded, env)       -> StartupKeyReport
 *
 * WHY A PURE FUNCTION. `index.ts` must do nothing but log what this returns,
 * so the decision is testable without spawning a process or capturing global
 * stdout — the same discipline `resolveApiPort` already follows.
 *
 * NAMES ONLY, NEVER VALUES. The report is built from the NAME SET
 * `loadServerEnv` returns plus `name in env` presence checks. No value, prefix,
 * suffix or length ever enters it: a secret must not reach a log line, and the
 * only way to guarantee that is to never read the value at all.
 *
 * ABSENCE IS A WARNING, NEVER A FAILURE. An ElevenLabs-less run is a
 * legitimate configuration (PRD arms differ in which providers they touch), so
 * this returns `level: 'warn'` and nothing else — it never throws and the
 * caller never exits.
 *
 * SOURCE IS PART OF THE CLAIM. 'dotenv' vs 'environment' is what lets a
 * deployment confirm its real env vars are the ones in force rather than a
 * stray `.env` beside the build.
 *
 * SILENCE UNDER TEST is a property OF THE REPORT (`lines` is empty), not of the
 * caller — so it is asserted here rather than trusted to a guard in index.ts.
 * `keys` is still populated under test, so the classification stays testable.
 * ==========================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Repo-root `.env` — the default a normal `npm run dev` should pick up. */
export const DEFAULT_ENV_FILE = path.resolve(moduleDir, '../../.env');

/**
 * Parses one `.env` line into a [name, value] pair, or null when the line
 * carries no assignment (blank, comment, or malformed).
 */
function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null;

  // `export FOO=bar` is common in hand-written files and harmless to accept.
  const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;

  const eq = withoutExport.indexOf('=');
  if (eq <= 0) return null;

  const name = withoutExport.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;

  let value = withoutExport.slice(eq + 1).trim();
  // Strip one matching pair of surrounding quotes, if present.
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  if (quoted) value = value.slice(1, -1);

  return [name, value];
}

/**
 * Loads `file` into `process.env` and returns the set of names it SET.
 * Names already present in the environment are left untouched and are not
 * reported as loaded.
 */
export function loadServerEnv(file: string = DEFAULT_ENV_FILE): Set<string> {
  const loaded = new Set<string>();

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // No file is a normal state, not a failure.
    return loaded;
  }

  for (const line of text.split('\n')) {
    const pair = parseLine(line);
    if (pair === null) continue;
    const [name, value] = pair;
    // The real environment wins.
    if (process.env[name] !== undefined) continue;
    process.env[name] = value;
    loaded.add(name);
  }

  return loaded;
}

/* ======================== TICKET 038 — startup diagnostic ================= */

/**
 * The provider keys the server reads. Exactly the names `src/server/**` looks
 * up in `process.env`, so a key the server never uses is never reported as
 * missing.
 */
export const PROVIDER_KEY_NAMES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ELEVENLABS_API_KEY',
] as const;

export type ProviderKeyName = (typeof PROVIDER_KEY_NAMES)[number];

/** Where a present key came from. `null` when the key is absent. */
export type ProviderKeySource = 'dotenv' | 'environment';

export interface ProviderKeyStatus {
  name: ProviderKeyName;
  present: boolean;
  /** 'dotenv' when `loadServerEnv` set it; 'environment' when it was already there. */
  source: ProviderKeySource | null;
}

export interface StartupKeyReport {
  /** One entry per PROVIDER_KEY_NAMES, in that order. */
  keys: ProviderKeyStatus[];
  /** Names of the absent keys, in PROVIDER_KEY_NAMES order. */
  missing: ProviderKeyName[];
  /** 'warn' iff at least one key is absent. Never an error. */
  level: 'info' | 'warn';
  /** What index.ts logs, verbatim. EMPTY under NODE_ENV=test. */
  lines: string[];
}

/**
 * Builds the startup diagnostic from the names `loadServerEnv` set plus the
 * environment it set them into. Pure: reads no file, logs nothing, throws
 * never, and never touches a key's VALUE.
 */
export function describeProviderKeys(
  loaded: Set<string>,
  env: NodeJS.ProcessEnv = process.env,
): StartupKeyReport {
  const keys: ProviderKeyStatus[] = PROVIDER_KEY_NAMES.map((name) => {
    // An EMPTY STRING is absent: a bare `FOO=` line in `.env` sets the name
    // without configuring anything, and reporting it as present would say the
    // server is configured when the very next provider call will fail.
    const present = (env[name] ?? '') !== '';
    // `loaded` is what `loadServerEnv` SET, so a name in it that is present can
    // only have come from the file. Names outside PROVIDER_KEY_NAMES are never
    // consulted — the report describes the keys the server reads, nothing else.
    const source: ProviderKeySource | null = !present
      ? null
      : loaded.has(name)
        ? 'dotenv'
        : 'environment';
    return { name, present, source };
  });

  const missing = keys.filter((k) => !k.present).map((k) => k.name);

  // Only NAMES and the two fixed source words are ever interpolated. No value
  // is read beyond the emptiness test above, so no value, prefix, suffix or
  // length can reach a log line.
  const rendered =
    'provider keys · ' +
    keys
      .map((k) =>
        k.present
          ? `${k.name} present (${k.source === 'dotenv' ? 'from .env' : 'already in environment'})`
          : `${k.name} ABSENT`,
      )
      .join(' · ');

  return {
    keys,
    missing,
    // Absence never fails: an ElevenLabs-less run is a legitimate configuration.
    level: missing.length > 0 ? 'warn' : 'info',
    // Silence under test is a property of the REPORT, and only of `lines` —
    // `keys` and `missing` stay populated so the classification is testable.
    lines: env.NODE_ENV === 'test' ? [] : [rendered],
  };
}
