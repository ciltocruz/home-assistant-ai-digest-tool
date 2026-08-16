# Design Spec: UI Form Controls Redesign (Switches & Radio Cards)

Date: 2026-08-16
Status: Approved

## Problem
In `settings.tsx` and `onboarding.tsx`, form controls for checkboxes and secret radio options suffer from CSS scoping issues. The generic selector `.control-form input` applies `appearance: none;` and `width: 100%;` indiscriminately to all inputs, removing native rendering for radios and checkboxes without providing full custom styling.

This causes:
1. Secret radio buttons ("Conservar el valor actual" / "Reemplazar con un valor nuevo") to stretch into full-width empty dark input boxes.
2. Schedule and warning checkboxes ("Activar este horario") to render as static, unstyled grey circles without checkmark indicators.

## Proposed Solution

### 1. CSS Selector Scoping Fix
Refactor `.control-form input` in `styles.css` to target only text-based inputs:
```css
.control-form input:not([type="checkbox"]):not([type="radio"]),
.control-form select,
.control-form textarea {
  /* text input styles */
}
```

### 2. Modern Toggle Switch for Checkboxes
Update `.checkbox-label` to render custom toggle switches:
- Hidden native input for accessibility (`sr-only` or styled container).
- Custom track (`.switch-track`) and knob (`.switch-thumb`).
- Smooth transitions for active state:
  - Background: `var(--bg-glass)` -> `var(--ha-orange)`
  - Knob position: `translateX(0)` -> `translateX(1.2rem)`
- Hover and focus ring indicators for keyboard navigation (`:focus-visible`).

### 3. Interactive Radio Cards for Secret Controls
Redesign `.secret-controls` in `settings.tsx`:
- Render choices as distinct cards (`.secret-radio-card`).
- Custom radio indicator dot (`.radio-indicator` with `.radio-dot`).
- Selected state highlighting:
  - Border: `1px solid var(--ha-orange)`
  - Background: `rgba(255, 107, 53, 0.08)`
  - Dot: Filled `--ha-orange` inner circle.
- Password input for replacement appears smoothly below the active replacement option.

## Scope of Changes
- `frontend/src/styles.css`
- `frontend/src/settings.tsx`
- `frontend/src/onboarding.tsx`
- Verification via unit/component tests in `frontend/src/settings.test.tsx` and `frontend/src/onboarding.test.tsx`.

## Verification Strategy
1. Component unit tests with Vitest (`pnpm test`).
2. Build validation with TypeScript & Vite (`pnpm build`).
3. Deploy commit to Cisne and verify live UI.
