# 001 — Scope ScoringInfographicStudio toolbar transitions off `all`

- **Status**: DONE
- **Commit**: 6da444b
- **Severity**: HIGH
- **Category**: Performance
- **Estimated scope**: 1 file, 3 one-line edits

## Problem

`components/ScoringInfographicStudio.module.css` has three buttons whose hover/active
feedback is driven by `transition: all 0.15s ease`, which animates every animatable
property (including layout-triggering ones) instead of just the ones that actually
change:

```css
/* components/ScoringInfographicStudio.module.css:38 — .tabBtn, current */
.tabBtn {
  ...
  transition: all 0.15s ease;
  ...
}
```

```css
/* components/ScoringInfographicStudio.module.css:82 — .toggleBtn, current */
.toggleBtn {
  ...
  transition: all 0.15s ease;
}
```

```css
/* components/ScoringInfographicStudio.module.css:105 — .downloadBtn, current */
.downloadBtn {
  ...
  transition: all 0.15s ease;
  ...
}
```

All three only ever change `background`, `color`, and `border-color` on hover/active
(see `.tabBtn:hover` at line 42, `.tabActive` at line 48, `.toggleActive` at line 85,
`.downloadBtn:hover` at line 109 — that one also changes `transform`/`box-shadow`).

## Target

```css
/* components/ScoringInfographicStudio.module.css:38 — .tabBtn, target */
transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
```

```css
/* components/ScoringInfographicStudio.module.css:82 — .toggleBtn, target */
transition: background-color 0.15s ease, color 0.15s ease;
```

```css
/* components/ScoringInfographicStudio.module.css:105 — .downloadBtn, target */
transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
```

## Repo conventions to follow

No shared `--ease-*`/`--duration-*` tokens exist yet in this app (finding #10 covers
introducing them) — keep the existing bare `0.15s ease` value, just scope the
`property` list. Don't invent new easing/duration values here.

## Steps

1. `components/ScoringInfographicStudio.module.css:38` — replace `transition: all 0.15s ease;` with `transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;`.
2. `components/ScoringInfographicStudio.module.css:82` — replace `transition: all 0.15s ease;` with `transition: background-color 0.15s ease, color 0.15s ease;` (this selector never changes `border-color`).
3. `components/ScoringInfographicStudio.module.css:105` — replace `transition: all 0.15s ease;` with `transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;` (this one also animates `transform`/`box-shadow` on hover, see line 109-113).

## Boundaries

- Do NOT touch `.tabActive`, `.toggleActive`, `:hover`/`:disabled` rule bodies — only the three `transition` declarations.
- Do NOT add new CSS custom properties in this plan.
- If any of the three selectors no longer contain `transition: all 0.15s ease;` verbatim, STOP and report the drift instead of guessing.

## Verification

- **Mechanical**: `npx tsc --noEmit` (no CSS-related failures expected — this doesn't touch TS) and `npx eslint components/ScoringInfographicStudio.module.css` if configured; otherwise just confirm the build (`npm run build`) still succeeds.
- **Feel check**: open a player profile page, open the scoring infographic panel, hover/click each tab, sub-toggle, and the download button. Confirm hover/active feedback still looks identical (same color changes, same 150ms speed) — this is a pure performance no-op, not a visual change.
- **Done when**: none of the three selectors contain `transition: all` anymore, and hover feedback is visually unchanged.
