# Animation fix plans (courtside-web player profile)

Source: `improve-animations` skill audit, 2026-09-16, player profile page (4 parallel
audit agents, 10 findings verified against code at commit `6da444b`). These are the
top 5 by leverage (out of 10 total findings); see session memory for the remaining 5
(#6-10, all MEDIUM/LOW) if more are wanted later.

| # | Title | Severity | Status | Depends on |
| --- | --- | --- | --- | --- |
| [001](001-scope-toolbar-transitions.md) | Scope toolbar `transition: all` to actual properties | HIGH | DONE | — |
| [002](002-court3d-no-remount-on-filter.md) | Stop remounting 3D scene on filter change | HIGH | DONE | — |
| [003](003-sparkline-uid-and-duration.md) | Stop sparkline replaying on unit toggle, cap duration | HIGH | DONE | — |
| [004](004-hudbar-transform-scalex.md) | HUD progress bar: `width` → `transform: scaleX()` | HIGH | DONE | — |
| [005](005-hud-bob-reduced-motion.md) | Gate HUD float animation behind reduced-motion | HIGH | DONE | — |

All 5 implemented and verified 2026-09-16 (`npx tsc --noEmit` clean of new errors, `npx eslint`
clean of new issues — only pre-existing unrelated warnings/errors remain). Feel-check in a real
browser session still recommended before shipping. Note: `npm run build` currently fails at the
TypeScript gate on two **pre-existing, unrelated** errors in `CourtHeroExpand.tsx:132,146`
(`string | undefined` not assignable — from the dropdown-filter feature in commit `6da444b`,
predates this work) — not touched by these plans.

## Execution order

No dependencies between plans — each touches a disjoint set of files/selectors and can
be executed in any order. Recommended order is by risk, easiest first:

1. **001** — pure CSS property scoping, zero behavior change.
2. **004** — small CSS + one inline-style line change.
3. **003** — two one-line edits in `PlayerForm.tsx`.
4. **005** — one new const + one condition change in `Court3DScene.tsx`.
5. **002** — the only structural refactor (splits one effect into two in
   `Court3DScene.tsx` + drops a `key` prop in `CourtHeroExpand.tsx`). Do this last and
   verify 003/004/005's edits to the same file (`Court3DScene.tsx`) landed cleanly
   first, since 002 restructures the effect those edits live inside.
