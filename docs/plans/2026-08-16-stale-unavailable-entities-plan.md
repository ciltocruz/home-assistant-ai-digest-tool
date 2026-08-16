# Implementation Plan: Stale & Unavailable Entities Audit Feature

## Plan Overview
Build a real-time Home Assistant device and entity health check module. It queries HA states API, categorizes `unavailable` and `stale` (>24h inactive) entities, exposes `GET /api/entities/stale`, and presents a responsive status card on the frontend dashboard with domain filtering.

---

## Task 1: Add Shared DTOs for Stale Entities Audit
Files:
- Modify: `packages/shared/src/dtos.ts`
- Modify: `packages/shared/src/dtos.test.ts`

- [ ] **Step 1: Write TDD tests in `dtos.test.ts`**
  Add unit tests for `EntityIssueDtoSchema` and `StaleEntitiesResponseSchema` (valid inputs, invalid values, strict mode enforcement).

- [ ] **Step 2: Implement schemas in `dtos.ts`**
  Export `EntityIssueDtoSchema`, `StaleEntitiesResponseSchema` and inferred TypeScript types.

- [ ] **Step 3: Verify and commit**
  Run `pnpm test packages/shared/src/dtos.test.ts` and commit.

---

## Task 2: Implement HA Entities Auditor & Backend Endpoint
Files:
- Create: `backend/src/adapters/ha/entity-auditor.ts`
- Create: `backend/src/adapters/ha/entity-auditor.test.ts`
- Modify: `backend/src/http/app.ts`
- Modify: `backend/src/http/app.test.ts`

- [ ] **Step 1: Write TDD unit test for `auditEntityStates`**
  Test filtering unavailable (`state === 'unavailable' | 'unknown'`) and stale entities (last_updated > 24h ago).

- [ ] **Step 2: Implement `entity-auditor.ts`**
  Create `auditEntityStates(rawStates, nowIso, maxStaleHours)` logic.

- [ ] **Step 3: Implement `GET /api/entities/stale` endpoint in `app.ts`**
  Add route invoking HA API state reader, auditing states, and returning `StaleEntitiesResponseSchema`.

- [ ] **Step 4: Verify and commit**
  Run `pnpm test backend/` and commit.

---

## Task 3: Implement Frontend Stale Devices UI Card & Filtering
Files:
- Modify: `frontend/src/api-client.ts`
- Create: `frontend/src/stale-entities.tsx`
- Create: `frontend/src/stale-entities.test.tsx`
- Modify: `frontend/src/dashboard.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/i18n/locales/es.json` & `en.json`

- [ ] **Step 1: Add `getStaleEntities` to `api-client.ts`**

- [ ] **Step 2: Implement `StaleEntitiesCard` component in `stale-entities.tsx`**
  Filter tabs (`Todos`, `Unavailable`, `Stale`), search input, domain badges (Zigbee, Sensor, Light, etc.), relative time formatting ("hace 4 horas").

- [ ] **Step 3: Add unit tests in `stale-entities.test.tsx`**

- [ ] **Step 4: Integrate into Dashboard (`dashboard.tsx`) and add styles in `styles.css`**

- [ ] **Step 5: Verify and commit**
  Run `pnpm vitest run frontend` and commit.
