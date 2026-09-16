# 003 — Stop sparkline replaying on every unit toggle, cap duration to budget

- **Status**: DONE
- **Commit**: 6da444b
- **Severity**: HIGH
- **Category**: Interruptibility, Purpose & frequency, Easing & duration
- **Estimated scope**: 1 file, 2 edits

## Problem

`components/PlayerForm.tsx:687`:

```tsx
/* current */
const spark = buildSparkSvg(points, { uid: `${form.pcode}-${key}-${unit}`, digits: def.digits, pct });
```

`unit` is the per-possession/per-40-minutes toggle (clicked frequently, tens of times
per session per the audit's frequency map). Because it's baked into `uid`, every toggle
click generates a new `uid`, which produces new `pfw-${uid}`/`pfp-${uid}` clip-path ids
and a new `@keyframes pfw-${uid}` (`PlayerForm.tsx:352-353`) — so React sees brand-new
SVG element ids and the left-to-right wipe-in animation replays from zero on every
toggle click, even though the card never actually unmounted.

The animation itself is also over budget — `PlayerForm.tsx:352`:

```css
/* current */
.pfw-${uid}{transform-box:view-box;transform-origin:0 0;animation:pfw-${uid} .9s cubic-bezier(.22,.61,.36,1) both}
```

900ms is a mount-reveal animation for a small stat card, not a modal — AUDIT.md's
duration budget table caps UI animations at 300ms (only "Modals, drawers" get up to
500ms).

## Target

```tsx
/* components/PlayerForm.tsx:687 — target: unit removed from uid */
const spark = buildSparkSvg(points, { uid: `${form.pcode}-${key}`, digits: def.digits, pct });
```

```css
/* components/PlayerForm.tsx:352 — target: duration cut to budget */
.pfw-${uid}{transform-box:view-box;transform-origin:0 0;animation:pfw-${uid} .28s cubic-bezier(.22,.61,.36,1) both}
```

Keep the existing `cubic-bezier(.22,.61,.36,1)` curve (already a strong ease-out shape,
matches AUDIT.md's `--ease-out` intent) — only the duration changes, `.9s` → `.28s`.

## Repo conventions to follow

- `uid` is only used to scope SVG ids per-card (see `safeId(opts.uid)` at
  `PlayerForm.tsx:293` and its uses at lines 317/352/353/358/359/363) — it does not need
  to encode every prop that affects the rendered values, only enough to keep ids unique
  *across concurrently-rendered cards*. `key` in the trend-card loop is already `key` (the
  stat key, e.g. `PlayerForm.tsx:696` `<figure ... key={key}>`), so `${form.pcode}-${key}`
  is still unique per card on the page even with `unit` removed.

## Steps

1. `PlayerForm.tsx:687` — change `uid: \`${form.pcode}-${key}-${unit}\`` to `uid: \`${form.pcode}-${key}\``.
2. `PlayerForm.tsx:352` — change `.9s` to `.28s` in the `animation:pfw-${uid} .9s cubic-bezier(.22,.61,.36,1) both` string (leave the cubic-bezier value and `both` fill-mode unchanged).

## Boundaries

- Do NOT change `buildSparkSvg`'s signature or any other caller of it.
- Do NOT change the `pfp-${uid}` clip path or any non-uid, non-duration logic in `buildSparkSvg`.
- Do NOT touch the `unit`/`key` values used elsewhere in the render (e.g. `leagueValue(s, key, unit)`, `rateValue`, `deltaValue`) — only the `uid` string passed to `buildSparkSvg`.
- If `PlayerForm.tsx:687` or `:352` no longer contain the exact strings quoted above (drift since commit `6da444b`), STOP and report instead of guessing.

## Verification

- **Mechanical**: `npx tsc --noEmit` passes; `npx eslint components/PlayerForm.tsx` passes; `npm run build` succeeds.
- **Feel check**: open a player profile's Form panel, let the per-possession sparklines finish their initial wipe-in, then click the per-40-minutes toggle several times in a row:
  - The sparkline should NOT replay the wipe-in animation on toggle clicks anymore — only on first mount / initial page load.
  - The initial wipe-in (on mount) should now visibly finish in well under half a second (280ms) instead of nearly a full second.
  - In DevTools Animations panel, set playback to 10% on first load and confirm the clip-path rect scales `0 → 1` smoothly over the shortened duration with no visible stepping.
  - Toggle `prefers-reduced-motion` (Rendering panel) and confirm the wipe-in is skipped entirely (unchanged — this was already gated by the existing `@media (prefers-reduced-motion: no-preference)` wrapper at line 350).
- **Done when**: rapid unit-toggle clicking never restarts the sparkline animation, and the one-time mount animation completes in ≤300ms.
