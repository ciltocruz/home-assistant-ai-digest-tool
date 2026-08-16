# Design Spec: Home Dashboard Redesign (Command Center KPI Cards & Timeline)

Date: 2026-08-16
Branch: `feature/home-redesign`
Status: Approved

## Problem
The current Home / Dashboard view (`dashboard.tsx`) presents information in a flat vertical layout with plain text for system state ("Estado actual") and basic history previews. It lacks visual hierarchy, KPI metrics, and a modern "command center" aesthetic.

## Proposed Design

### 1. Hero KPI Metrics Bar (`.dashboard-kpi-grid`)
Replace the plain text `dashboard-state` panel with a 4-card KPI metric grid:
- **Card 1: Global Health Status** (Saludable / Atención requerida with indicator dot & status color).
- **Card 2: Severity Counter** (Count of Critical and Warning findings in the latest report).
- **Card 3: AI Provider** (Current active provider badge, e.g., Gemini / OpenAI).
- **Card 4: Notification Status** (Telegram delivery status of the latest run).

### 2. Prominent Latest Report Card (`.dashboard-latest-card`)
Enhance the latest report preview:
- Glassmorphic card styling with sutil glowing border (`var(--shadow-sm)` + `--ha-orange` accent).
- Large date/time typography.
- Clearly formatted severity chips (`.severity-chip--critical`, `.severity-chip--warning`, `.severity-chip--info`).
- Direct action link to view full report details.

### 3. Timeline View for History (`.history-timeline`)
Transform the history preview into a connected vertical timeline:
- Left timeline track with status nodes (green/orange/red dots).
- Compact report summary cards with date, result, and Telegram delivery status.

## Scope of Files
- `frontend/src/dashboard.tsx`
- `frontend/src/styles.css`
- `frontend/src/dashboard.test.tsx`

## Verification & Rollback Strategy
1. Tests pass: `pnpm test`.
2. Build succeeds: `pnpm build`.
3. Deploy to Cisne from `feature/home-redesign`.
4. If user approves, merge to main branch. If user rejects, `git checkout fix/restore-v2-styles` and redeploy.
