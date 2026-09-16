# 002 — Stop remounting the whole 3D scene on filter change

- **Status**: DONE
- **Commit**: 6da444b
- **Severity**: HIGH
- **Category**: Purpose & frequency, Interruptibility
- **Estimated scope**: 2 files (`CourtHeroExpand.tsx`, `Court3DScene.tsx`), one structural refactor

## Problem

`components/CourtHeroExpand.tsx:171`:

```tsx
<Court3DScene key={filterStr} shots={filteredShots} accentColor={accentColor} onProgress={setProgress} skipToken={skipToken} groupBy={effectiveGroupBy} showMadeArcs={showMadeArcs} showMissedArcs={showMissedArcs} />
```

`filterStr` changes every time the user picks a different team/season/quarter filter
(`handleFilterChange` at `CourtHeroExpand.tsx:77`) — dozens of times per session. Because
it's used as React `key`, every change unmounts and remounts `Court3DScene` entirely,
which re-runs the full mount effect at `Court3DScene.tsx:78-479` — rebuilding the
renderer, camera, lights, floor, halo, stars, controls, resize observer, AND replaying
the multi-second cinematic build-up (`tick()`/camera pan) from zero every time.

Inside `Court3DScene.tsx`, the single effect at line 78 has `[]` deps (mount-once) and
reads `shots`, `groupBy`, `accentColor` only via closure at mount time — there is
currently no way to react to prop changes without a full remount.

## Target

`CourtHeroExpand.tsx` stops keying on `filterStr`:

```tsx
/* components/CourtHeroExpand.tsx:171 — target */
<Court3DScene shots={filteredShots} accentColor={accentColor} onProgress={setProgress} skipToken={skipToken} groupBy={effectiveGroupBy} showMadeArcs={showMadeArcs} showMissedArcs={showMissedArcs} />
```

`Court3DScene.tsx` splits its one big effect into two:

1. A **static setup effect** (`[]` deps) that creates the renderer, camera, lights,
   floor, court lines, rim/backboard/pole, halo, stars, hud sprite, controls, and the
   `animate()` rAF loop, resize observer, and disposal cleanup. Scene/camera/renderer/
   controls/hudSprite/hudTex and the mutable arc/spot meshes are held in refs so the
   second effect can reach them.
2. A **data effect** keyed on `[shots, groupBy, accentColor]` that: removes the previous
   `madeSpotMesh`/`missedSpotMesh`/`madeArcs`/`missedArcs` from the scene and disposes
   their geometries/materials, rebuilds them from the new `shots`/`groupBy`, resets
   `madeShown`/`missedShown`/`batchIdx`/`ptsCounter`/camera position back to `camStart`,
   and restarts the `tick()` build-up playback — without touching the renderer/camera/
   controls/lights/floor that effect 1 already built.

## Repo conventions to follow

- This component already uses the ref pattern for cross-effect mutable state that
  shouldn't retrigger effects: `onProgressRef` (line 62), `skipRequestedRef` (line 66),
  `showMadeRef`/`showMissedRef` (lines 67-68). Follow the same pattern for the newly
  lifted `scene`/`camera`/`renderer`/`controls`/`render`/`hudSprite`/`hudTex`/`update3DHud`
  refs.
- `skipToken`/`showMadeArcs`/`showMissedArcs` are already handled as separate small
  effects that only touch refs (lines 69-76) — the new data effect follows that same
  shape (a focused effect that doesn't re-run the whole scene).

## Steps

1. In `Court3DScene.tsx`, add refs to hold cross-effect scene state, e.g.:
   `const sceneRef = useRef<THREE.Scene>(); const cameraRef = useRef<THREE.PerspectiveCamera>(); const rendererRef = useRef<THREE.WebGLRenderer>(); const controlsRef = useRef<OrbitControls>(); const renderRef = useRef<() => void>(); const hudSpriteRef = useRef<THREE.Sprite>(); const hudTexRef = useRef<THREE.CanvasTexture>(); const update3DHudRef = useRef<(label: string | null, ptsStr: string) => void>(); const arcMeshesRef = useRef<{ madeSpotMesh: THREE.InstancedMesh; missedSpotMesh: THREE.InstancedMesh; madeArcs: THREE.LineSegments; missedArcs: THREE.LineSegments } | null>(null); const playbackStateRef = useRef<{ cancel: () => void } | null>(null);`
2. Split the effect at line 78: everything from `const scene = new THREE.Scene()` (line 84) through the stars/floor/lines/rim/backboard/pole/halo/hudSprite/lights/camera/controls/renderer/resize-observer setup (lines 84-339) stays in the `[]`-deps effect. Assign each into the refs from step 1 as it's created, instead of only using local `const`s.
3. Move everything from `// ── 슛 마커 & 궤적 데이터 준비 ──` (line 191) through the end of `tick()`/`finishInstant()` (line 424) into a new function, e.g. `rebuildShots()`, that: (a) if `arcMeshesRef.current` is set, removes those four objects from `sceneRef.current` and disposes their geometry/material; (b) rebuilds `madeSpotMesh`/`missedSpotMesh`/`madeArcGeo`/`missedArcGeo`/`madeArcs`/`missedArcs` exactly as today but reading `shots`/`groupBy`/`accentColor` from the latest props (via a `propsRef` updated every render, same pattern as `onProgressRef`) instead of the effect closure; (c) stores the new meshes in `arcMeshesRef`; (d) resets `camera.position` to `camStart`; (e) starts the `tick()` build-up loop, storing a cancel handle (clear the pending `setTimeout`) in `playbackStateRef.current`.
4. Add a second `useEffect(() => { if (!ready) return; playbackStateRef.current?.cancel(); rebuildShots(); }, [shots, groupBy, accentColor])` — `ready` guards against running before the static setup effect has created the scene (e.g. a `sceneReadyRef` boolean flipped at the end of effect 1, or simply calling `rebuildShots()` once directly at the end of effect 1 for the initial mount instead of duplicating logic).
5. In the disposal cleanup of the static effect (currently lines 461-478), also dispose whatever is currently in `arcMeshesRef.current` (same geometry/material dispose loop) — today's `scene.traverse` cleanup already does this generically for anything left in the scene, so no change needed there as long as step 3(a) doesn't leave orphaned objects when the component unmounts mid-rebuild.
6. In `CourtHeroExpand.tsx:171`, remove `key={filterStr}` from the `<Court3DScene>` element.
7. `handleFilterChange` (`CourtHeroExpand.tsx:77-81`) already calls `setProgress(null)` and `setSkipToken(0)` on every filter change — leave that as-is; it still works because `onProgress` fires fresh events from the restarted `tick()` loop in step 3.

## Boundaries

- Do NOT change the visual design of the scene (colors, geometry, camera angles, lighting) — this is a lifecycle refactor only.
- Do NOT change `CourtHeroExpand.tsx` beyond removing the `key` prop.
- Do NOT touch `skipToken`/`showMadeArcs`/`showMissedArcs` handling (lines 66-76) — those effects are already correctly scoped and untouched by this refactor.
- If `shots` or `groupBy` change while a previous `tick()` build-up is still running (fast filter-clicking), the rebuild must cancel the in-flight `setTimeout` chain (via `disposed`-style guard, same idea as the existing `disposed` flag but scoped to the playback, not the whole component) before starting the new one — do not let two `tick()` loops run concurrently.
- If the code at any cited line doesn't match what's described here (drift since commit `6da444b`), STOP and report instead of improvising.

## Verification

- **Mechanical**: `npx tsc --noEmit` passes with no new errors; `npx eslint components/Court3DScene.tsx components/CourtHeroExpand.tsx` passes; `npm run build` succeeds.
- **Feel check**: open a player profile with multiple seasons/teams/quarters, open the 3D shot map, and switch between "전체"/team/season/quarter filter options rapidly several times:
  - The renderer/canvas should NOT flash, resize-jump, or flicker on filter change (a full remount would briefly show an empty container).
  - The cinematic camera pan + build-up SHOULD still replay from the start for the new filter's shots (this is intentional per the existing HUD copy at `CourtHeroExpand.tsx:182`: "열 때 한 번... 쌓입니다") — only the *scene setup* (renderer/lights/camera/controls) should stop rebuilding, not the shot playback.
  - Rotate/zoom the camera, switch filters mid-drag, and confirm no console errors about disposed WebGL context or duplicate scene objects.
  - Click rapidly through 3+ filters in under a second and confirm no visual doubling of arcs/spots (old meshes must be fully removed before new ones are added).
- **Done when**: `key={filterStr}` is gone, filter switches no longer tear down the WebGL context, and shot playback still restarts correctly per filter with no leaked geometry (check DevTools Memory/Performance panel for a filter-switch loop — heap should not grow unbounded over 20 switches).
