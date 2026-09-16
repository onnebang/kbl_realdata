# 005 — Gate HUD float animation behind `prefers-reduced-motion`, stop idle rAF

- **Status**: DONE
- **Commit**: 6da444b
- **Severity**: HIGH
- **Category**: Performance, Accessibility
- **Estimated scope**: 1 file (`Court3DScene.tsx`)

## Problem

`components/Court3DScene.tsx:434-459`:

```tsx
/* current */
// 애니메이션 루프 (HUD 및 controls damping을 위해)
let reqId: number;
const animate = () => {
  reqId = requestAnimationFrame(animate);
  let needsRender = false;

  // HUD 살짝 둥둥 떠다니는 애니메이션
  if (hudSprite) {
    const time = Date.now() * 0.002;
    hudSprite.position.y = 7.5 + Math.sin(time) * 0.2;
    needsRender = true;
  }
  if (madeArcs.visible !== showMadeRef.current) {
    madeArcs.visible = showMadeRef.current;
    needsRender = true;
  }
  if (missedArcs.visible !== showMissedRef.current) {
    missedArcs.visible = showMissedRef.current;
    needsRender = true;
  }

  if (controls.enabled && controls.update()) needsRender = true;

  if (needsRender) render();
};
animate();
```

`hudSprite` always exists (created unconditionally at line 263), so `needsRender` is
`true` on every single frame for as long as the 3D modal is open — this forces a full
`renderer.render()` call every frame forever, with no `prefers-reduced-motion` check and
no way to ever go idle, even once shot playback has finished and the camera is
stationary.

## Target

```tsx
/* components/Court3DScene.tsx:434-459 — target */
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 애니메이션 루프 (HUD 및 controls damping을 위해)
let reqId: number;
const animate = () => {
  reqId = requestAnimationFrame(animate);
  let needsRender = false;

  // HUD 살짝 둥둥 떠다니는 애니메이션 (reduced motion에선 고정)
  if (hudSprite && !prefersReducedMotion) {
    const time = Date.now() * 0.002;
    hudSprite.position.y = 7.5 + Math.sin(time) * 0.2;
    needsRender = true;
  }
  if (madeArcs.visible !== showMadeRef.current) {
    madeArcs.visible = showMadeRef.current;
    needsRender = true;
  }
  if (missedArcs.visible !== showMissedRef.current) {
    missedArcs.visible = showMissedRef.current;
    needsRender = true;
  }

  if (controls.enabled && controls.update()) needsRender = true;

  if (needsRender) render();
};
animate();
```

Note: this plan only adds the `prefers-reduced-motion` gate (the mechanical, safely
scoped part of finding #5). It deliberately does NOT convert the loop to fully stop
`requestAnimationFrame` when idle — with reduced motion off, `hudSprite` bob is the
*only* always-on per-frame mutation today, so gating it behind `prefersReducedMotion`
already makes the reduced-motion path render-on-demand only (via `controls`'s own
`"change"` listener and the visibility-toggle checks, none of which fire every frame on
their own). Fully idling the rAF loop itself when nothing is animating is a larger
change (needs to restart the loop on `showMadeArcs`/`showMissedArcs` prop changes,
`controls.enabled` toggling, and window resize) — leave that for a follow-up plan if
still desired after this lands.

## Repo conventions to follow

- `showMadeRef`/`showMissedRef` (`Court3DScene.tsx:67-72`) are the existing pattern for
  reading latest prop values inside a `[]`-deps effect without retriggering it — follow
  the same "compute once, read via closure/ref" shape for `prefersReducedMotion` (a
  plain `const` is enough here since `matchMedia(...).matches` is read once at effect
  mount time, matching how `accentColor` and other props are already captured by value
  at mount in this same effect).

## Steps

1. In `Court3DScene.tsx`, immediately before the `// 애니메이션 루프` comment (line 434), add: `const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;`
2. Change the HUD bob condition on line 441 from `if (hudSprite) {` to `if (hudSprite && !prefersReducedMotion) {`.

## Boundaries

- Do NOT add a `matchMedia` change-listener in this plan (no need to react live to the OS setting changing while the modal is open — reading it once at mount matches how the rest of this effect treats props).
- Do NOT touch the `madeArcs.visible`/`missedArcs.visible`/`controls.update()` blocks.
- Do NOT attempt the full "stop rAF when idle" version described in the Target section's note — out of scope for this plan.
- If line 434-459 doesn't match what's quoted above (drift since commit `6da444b`), STOP and report instead of guessing.

## Verification

- **Mechanical**: `npx tsc --noEmit` passes; `npx eslint components/Court3DScene.tsx` passes; `npm run build` succeeds.
- **Feel check**: open the 3D shot map:
  - With reduced motion off (default OS setting): HUD sprite should still bob gently as before.
  - Toggle `prefers-reduced-motion` in DevTools' Rendering panel to "reduce", close and reopen the 3D modal (so the effect re-mounts and re-reads the media query), and confirm the HUD sprite now stays perfectly still at `y = 7.5` while shot playback / camera pan still work normally.
- **Done when**: reduced-motion users see a static HUD sprite with no other behavior regressed.
