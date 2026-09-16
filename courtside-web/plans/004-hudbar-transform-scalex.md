# 004 — Switch HUD progress bar from `width` to `transform: scaleX()`

- **Status**: DONE
- **Commit**: 6da444b
- **Severity**: HIGH
- **Category**: Performance
- **Estimated scope**: 2 files, small

## Problem

`components/court-hero-expand.module.css:117`:

```css
/* current */
.hudBarFill {
  height: 100%;
  transition: width 120ms linear;
}
```

`components/CourtHeroExpand.tsx:166`:

```tsx
/* current */
<div className={styles.hudBarFill} style={{ width: `${((progress?.shown ?? 0) / Math.max(1, progress?.total ?? 1)) * 100}%`, background: accentColor }} />
```

This bar updates on every `tick()` batch during the 3D build-up playback (potentially
every 150-800ms per `Court3DScene.tsx:354`, `tickMs`). Animating `width` triggers
layout + paint + composite on every tick; `transform` only triggers composite.

## Target

```css
/* components/court-hero-expand.module.css:117 — target */
.hudBarFill {
  height: 100%;
  width: 100%;
  transform-origin: left center;
  transition: transform 120ms linear;
}
```

```tsx
/* components/CourtHeroExpand.tsx:166 — target */
<div className={styles.hudBarFill} style={{ transform: `scaleX(${(progress?.shown ?? 0) / Math.max(1, progress?.total ?? 1)})`, background: accentColor }} />
```

## Repo conventions to follow

- `.hudBar` (the track, `court-hero-expand.module.css:112-115`) already has `overflow`
  implicitly clipped by its fixed `height: 3px` — no change needed there. Only the fill
  element's sizing mechanism changes from `width`-based to `transform`-based.

## Steps

1. `components/court-hero-expand.module.css:117` — in `.hudBarFill`, add `width: 100%;` and `transform-origin: left center;`, and change `transition: width 120ms linear;` to `transition: transform 120ms linear;`.
2. `components/CourtHeroExpand.tsx:166` — replace the inline `width: '...%'` style with `transform: 'scaleX(...)'` using the same ratio expression (`(progress?.shown ?? 0) / Math.max(1, progress?.total ?? 1)`, without the `* 100` and `%` suffix since `scaleX` takes a 0–1 fraction, not a percentage).

## Boundaries

- Do NOT change `.hudBar` (the track element) or its styles.
- Do NOT change the `tickMs`/`progress` calculation logic in `Court3DScene.tsx` — only how the fill visually renders the same `progress` value.
- If the cited lines don't match what's shown above (drift since commit `6da444b`), STOP and report instead of guessing.

## Verification

- **Mechanical**: `npx tsc --noEmit` passes; `npx eslint components/CourtHeroExpand.tsx` passes; `npm run build` succeeds.
- **Feel check**: open the 3D shot map and watch the HUD progress bar during build-up playback:
  - The bar should visually fill left-to-right identically to before (same speed, same final full-width state).
  - In DevTools Performance panel, record a playback run and confirm the `.hudBarFill` updates now show as Composite-only (no Layout/Paint) in the frame breakdown.
- **Done when**: the bar fill is driven by `transform: scaleX()` and DevTools shows no layout thrashing during playback.
