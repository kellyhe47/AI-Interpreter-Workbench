---
id: 001
title: Frozen arm definitions and derived armTag
status: green
depends_on: []
touches: [src/core/arms.ts, src/core/arms.test.ts]
iterations: 0
test_files: [src/core/arms.test.ts]
branch: ""
---

## Scope

**ADD `src/core/arms.ts`** — the single source of truth for what an "arm" is, and the
function every downstream surface (storage, config panel, runs list, results aggregation)
calls to find out which arm a configuration belongs to.

Builds nothing else. No UI, no storage, no registry wiring. Isomorphic TypeScript: this file
is compiled by BOTH `tsconfig.json` (DOM) and `tsconfig.server.json` (node), so it must not
import anything node-only or DOM-only. It may import types from `src/core/timing.ts`
(`Mode = 'cascade' | 'realtime'`).

This is PRD §6's "quarantine — membership is derived, never declared" and decision-log
entries 22d–22e. **There is no arm-labelling UI anywhere in the product**; `deriveArmTag` is
the only way a run gets a tag, which is what makes mislabelling structurally impossible
rather than merely discouraged.

## Design (normative — implement exactly this shape)

```ts
export type ArmTag = 'A' | 'B' | 'C' | 'ad-hoc';

/** Provider triple for a cascade configuration. Values are MODEL ids (see MENUS). */
export interface ProviderTriple { stt: string; mt: string; tts: string }

export interface RunConfig {
  architecture: Mode;                 // 'realtime' | 'cascade'
  /** Realtime model id; only meaningful when architecture === 'realtime'. */
  realtimeModel?: string;
  /** Required when architecture === 'cascade'. */
  providers?: ProviderTriple;
}

export interface ArmDefinition {
  tag: 'A' | 'B' | 'C';
  label: string;          // 'Arm A' | 'Arm B' | 'Arm C'
  description: string;
  config: RunConfig;      // the frozen recipe
}

export const ARMS: readonly ArmDefinition[];
export function deriveArmTag(config: RunConfig): ArmTag;
export function armLabel(tag: ArmTag): string;   // 'Arm B' | 'ad-hoc'
export const MENUS: { stt: readonly string[]; mt: readonly string[]; tts: readonly string[] };
export const DEFAULT_CASCADE_TRIPLE: ProviderTriple;   // === Arm B's triple
export const REALTIME_MODEL: string;                   // 'gpt-realtime'
```

**The three frozen arms (PRD §3):**

| Tag | architecture | recipe |
|---|---|---|
| A | `realtime` | `gpt-realtime` |
| B | `cascade` | `gpt-4o-transcribe` → `gpt-4o-mini` → `gpt-4o-mini-tts` |
| C | `cascade` | `gpt-4o-transcribe` → `gpt-4o-mini` → `eleven_flash_v2_5` |

**The selectable model menus (PRD §6 table) — model ids, in menu order:**

- `stt`: `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `scribe_v2_realtime`
- `mt`: `gpt-4o-mini`, `claude-haiku-4-5`
- `tts`: `gpt-4o-mini-tts`, `eleven_flash_v2_5`, `eleven_multilingual_v2`

No fixture appears in any menu (PRD §17, 23b) — listing a fixture beside real providers
invites a fabricated-output run into the ledger.

## Acceptance criteria

- [ ] `deriveArmTag({architecture:'realtime', realtimeModel:'gpt-realtime'})` → `'A'`
- [ ] `deriveArmTag` on Arm B's exact triple → `'B'`; on Arm C's exact triple → `'C'`
- [ ] Changing **any one** stage of Arm B's triple to another menu model → `'ad-hoc'`
      (cover all three stages, and cover the B→C TTS swap resolving to `'C'` not `'ad-hoc'`)
- [ ] A cascade config whose `providers` is missing/undefined → `'ad-hoc'` (never throws)
- [ ] A realtime config with a **different** `realtimeModel` (e.g. `gpt-realtime-mini`) →
      `'ad-hoc'` — model snapshots are a pinned control (PRD §8 register), so a different
      model is not Arm A
- [ ] A realtime config with `realtimeModel` omitted → `'A'` (the default realtime model is
      `REALTIME_MODEL`; omission means "the default", not "unknown")
- [ ] An unknown model id in any stage → `'ad-hoc'`, never a throw
- [ ] `deriveArmTag` ignores extra/unrelated keys on the config object (it matches on the
      recipe fields only, so callers may pass a richer run record through)
- [ ] `armLabel('B')` → `'Arm B'`; `armLabel('ad-hoc')` → `'ad-hoc'`
- [ ] `DEFAULT_CASCADE_TRIPLE` derives to `'B'` — the default panel state produces
      comparable runs rather than orphans (PRD §17, 23d)
- [ ] `ARMS` and `MENUS` are frozen at runtime: mutating them throws or is a no-op
      (`Object.freeze`), so no caller can redefine an arm
- [ ] Every model id appearing in any `ARMS` entry also appears in the corresponding `MENUS`
      list — the arms are assemblable from the UI menus

## Test plan

New file `src/core/arms.test.ts`. This is **PRD §13 test 8 (derived `armTag`)**, one of the
three new tests the v2 verification requires — write it table-driven over
`{config, expected}` cases.

## Attempt log

- iter 1: green. 40/40 ticket tests, full suite 35 files / 501 tests, both typechecks clean.
