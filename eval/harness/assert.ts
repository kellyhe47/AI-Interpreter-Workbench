/**
 * ASSERTION VOCABULARY FOR THE GOLDEN EVALS.
 *
 * `must_include` / `must_exclude` / `must_not_contain` / `digits_rendered` are
 * declared in the cases, so they are executed HERE, once, rather than
 * paraphrased twelve times. In particular `must_not_contain` is a REAL
 * assertion on every surface it is declared for — including the
 * `digits_rendered: 0` form, which on a DOM surface means no digit character
 * anywhere in the rendered subtree.
 */

import { expect } from 'vitest';

/** Everything the case's surface actually rendered/derived, as one string. */
export interface Rendered {
  /** What a reader sees, or the derived line(s) a pure case produces. */
  text: string;
  /** Where it came from, for the failure message. */
  label: string;
}

export function rendered(label: string, text: string): Rendered {
  return { label, text };
}

/** The text of a DOM subtree, normalized so assertions do not chase whitespace. */
export function domText(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Digit characters in a rendered subtree. `digits_rendered: 0` asserts this. */
export function digitsIn(text: string): string[] {
  return text.match(/\d/g) ?? [];
}

export function expectNoDigits(r: Rendered): void {
  const digits = digitsIn(r.text);
  expect(
    digits,
    `${r.label} must render NO digits (digits_rendered: 0) — found ${digits.length} in: ${r.text}`,
  ).toEqual([]);
}

/** `must_not_contain` — every needle absent from every surface listed. */
export function expectAbsent(needles: readonly string[], surfaces: readonly Rendered[]): void {
  for (const needle of needles) {
    for (const surface of surfaces) {
      expect(
        surface.text.includes(needle),
        `${surface.label} must NOT contain "${needle}" — it rendered: ${surface.text}`,
      ).toBe(false);
    }
  }
}

/** `must_include` on a rendered surface — literal containment. */
export function expectPresent(needles: readonly string[], surface: Rendered): void {
  for (const needle of needles) {
    expect(
      surface.text.includes(needle),
      `${surface.label} must contain "${needle}" — it rendered: ${surface.text}`,
    ).toBe(true);
  }
}

/**
 * `must_include` / `must_exclude` over a SET of ids (sessions, runs, records).
 * Kept separate from text containment: an id that happens to be a substring of
 * another id would make the text form silently wrong.
 */
export function expectIds(
  actual: readonly string[],
  opts: { include?: readonly string[]; exclude?: readonly string[]; label: string },
): void {
  const set = new Set(actual);
  for (const id of opts.include ?? []) {
    expect(set.has(id), `${opts.label} must INCLUDE "${id}" — it held [${actual.join(', ')}]`).toBe(
      true,
    );
  }
  for (const id of opts.exclude ?? []) {
    expect(set.has(id), `${opts.label} must EXCLUDE "${id}" — it held [${actual.join(', ')}]`).toBe(
      false,
    );
  }
}

/** `within_tolerance` — `{ field, target, pct }`. */
export function expectWithinPct(
  actual: number,
  target: number,
  pct: number,
  label: string,
): void {
  const slack = Math.abs(target) * (pct / 100);
  expect(
    Math.abs(actual - target) <= slack,
    `${label}: ${actual} is not within ${pct}% of ${target} (allowed ±${slack})`,
  ).toBe(true);
}

/**
 * A field the product does not expose yet. The case stays WIRED and fails with
 * the exact reason, rather than being softened into something that passes.
 */
export function requireField<T>(value: T | undefined, what: string, where: string): T {
  expect(
    value !== undefined,
    `${where} does not expose ${what} — the case cannot be satisfied by the current API`,
  ).toBe(true);
  return value as T;
}
