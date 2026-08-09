/**
 * GOLDEN EVAL LOADER — the 12 declarative cases in `eval/golden/*.json`, typed
 * and paired with the ticket each one belongs to.
 *
 * This is NOT part of `npm test`. It is a GATE, run separately (`npm run eval`),
 * and its failures are the acceptance criteria the product does not yet meet.
 * A green run today would mean the runner is broken — most of these cases
 * encode defects that are still open.
 *
 * THE CASES ARE THE SPEC, NOT THE TESTS. Nothing here may reinterpret a case to
 * make it pass: an expectation that is not executable against the current API
 * stays wired and FAILS with a message naming what is missing.
 */

/** Every case declares which surface it must be executed against. */
export type Surface = 'pure' | 'dom';

export interface GoldenCase {
  /** Two-digit file prefix — the case's stable id. */
  id: string;
  name: string;
  why: string;
  surface: Surface;
  given: Record<string, unknown>;
  expect: Record<string, unknown>;
  /** Ticket this case's acceptance criteria belong to, when one exists. */
  ticket: string | null;
  /** Source path, for a failure message that can be traced back. */
  file: string;
}

/**
 * Case → ticket. A failing run has to read as a WORK LIST, so every case that
 * traces to an open ticket names it in the test title.
 *
 * `null` means the case locks behaviour that is already landed (01–053) and has
 * no open ticket: 05 is ticket 001's derived-arm rule, 08 is ticket 007's pacer.
 */
const TICKETS: Readonly<Record<string, string | null>> = Object.freeze({
  '01': '055',
  '02': '055',
  '03': '055',
  '04': '055',
  '05': null,
  '06': '054',
  '07': '059',
  '08': null,
  '09': '051',
  '10': '060',
  '11': '061',
  '12': '056',
});

interface RawCase {
  name?: unknown;
  why?: unknown;
  surface?: unknown;
  given?: unknown;
  expect?: unknown;
}

const modules = import.meta.glob('../golden/*.json', { eager: true, import: 'default' });

function parse(file: string, raw: unknown): GoldenCase {
  const c = raw as RawCase;
  const id = /(\d\d)-/.exec(file)?.[1];
  if (id === undefined) throw new Error(`golden case ${file}: filename must start with NN-`);
  if (typeof c.name !== 'string') throw new Error(`golden case ${file}: missing "name"`);
  if (c.surface !== 'pure' && c.surface !== 'dom') {
    throw new Error(`golden case ${file}: "surface" must be "pure" or "dom"`);
  }
  return {
    id,
    name: c.name,
    why: typeof c.why === 'string' ? c.why : '',
    surface: c.surface,
    given: (c.given ?? {}) as Record<string, unknown>,
    expect: (c.expect ?? {}) as Record<string, unknown>,
    ticket: TICKETS[id] ?? null,
    file: file.replace('../', 'eval/'),
  };
}

/** Every case on disk, in id order. Ids are unique and contiguous. */
export const GOLDEN_CASES: readonly GoldenCase[] = Object.entries(modules)
  .map(([file, raw]) => parse(file, raw))
  .sort((a, b) => a.id.localeCompare(b.id));

/** The title a case reports under — the ticket is part of the work list. */
export function titleOf(c: GoldenCase): string {
  return `${c.id} · ${c.ticket === null ? 'no open ticket' : `ticket ${c.ticket}`} · ${c.name}`;
}

export function caseById(id: string): GoldenCase {
  const found = GOLDEN_CASES.find((c) => c.id === id);
  if (!found) throw new Error(`golden case ${id}: not found on disk`);
  return found;
}

/* ------------------------------------------------------------ accessors -- */

/**
 * Read a path out of a case's `expect` block. Every executor reads its
 * expectations FROM THE JSON rather than restating them, so editing a case
 * moves the assertion and a case nobody wired cannot silently pass.
 */
export function at(source: Record<string, unknown>, path: string): unknown {
  let node: unknown = source;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

export function num(source: Record<string, unknown>, path: string): number {
  const v = at(source, path);
  if (typeof v !== 'number') throw new Error(`golden case: "${path}" is not a number (got ${String(v)})`);
  return v;
}

export function strings(source: Record<string, unknown>, path: string): string[] {
  const v = at(source, path);
  if (!Array.isArray(v)) throw new Error(`golden case: "${path}" is not an array`);
  return v.filter((x): x is string => typeof x === 'string');
}

/** `must_include` / `must_exclude` / `must_surface` entries, by their `id`. */
export function ids(source: Record<string, unknown>, path: string): string[] {
  const v = at(source, path);
  if (!Array.isArray(v)) throw new Error(`golden case: "${path}" is not an array`);
  return v.map((entry) => {
    if (typeof entry === 'string') return entry;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string') throw new Error(`golden case: "${path}" entry has no string id`);
    return id;
  });
}
