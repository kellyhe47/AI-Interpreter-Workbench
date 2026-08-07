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
