# Batch Selection and Deletion of Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to select multiple historical reports from the UI history list and delete them in bulk with a batch action and confirmation dialog.

**Architecture:** Add shared DTOs (`BatchDeleteReportsRequestSchema`, `BatchDeleteReportsResponseSchema`), a backend HTTP endpoint `POST /api/digests/batch-delete`, store batch deletion methods in `sqlite-v2-stores.ts` and `runtime-persistence.ts`, and frontend state management in `report-history.tsx` with checkboxes, select-all controls, batch toolbar, and confirmation modal.

**Tech Stack:** TypeScript, Node.js, Fastify, React, Vitest, SQLite.

---

### Task 1: Add Shared DTOs for Batch Report Deletion

**Files:**
- Modify: `packages/shared/src/dtos.ts`
- Modify: `packages/shared/src/dtos.test.ts`

- [ ] **Step 1: Write failing tests in `dtos.test.ts`**

```ts
import { BatchDeleteReportsRequestSchema, BatchDeleteReportsResponseSchema } from './dtos.js';

describe('BatchDeleteReports DTOs', () => {
  it('validates valid batch delete request', () => {
    const valid = BatchDeleteReportsRequestSchema.parse({ ids: ['report-1', 'report-2'] });
    expect(valid.ids).toEqual(['report-1', 'report-2']);
  });

  it('rejects empty or invalid batch delete request', () => {
    expect(() => BatchDeleteReportsRequestSchema.parse({ ids: [] })).toThrow();
  });

  it('validates batch delete response', () => {
    const valid = BatchDeleteReportsResponseSchema.parse({ deletedCount: 2 });
    expect(valid.deletedCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/shared/src/dtos.test.ts`
Expected: FAIL with missing exports `BatchDeleteReportsRequestSchema`

- [ ] **Step 3: Add DTO schemas in `dtos.ts`**

```ts
export const BatchDeleteReportsRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1)
});
export type BatchDeleteReportsRequest = z.infer<typeof BatchDeleteReportsRequestSchema>;

export const BatchDeleteReportsResponseSchema = z.object({
  deletedCount: z.number().int().min(0)
});
export type BatchDeleteReportsResponse = z.infer<typeof BatchDeleteReportsResponseSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/shared/src/dtos.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/dtos.ts packages/shared/src/dtos.test.ts
git commit -m "feat(shared): add DTO schemas for batch report deletion"
```

---

### Task 2: Implement Backend Batch Deletion Endpoint and Store Support

**Files:**
- Modify: `backend/src/adapters/persistence/sqlite-v2-stores.ts`
- Modify: `backend/src/runtime-persistence.ts`
- Modify: `backend/src/http/app.ts`
- Modify: `backend/src/http/app.test.ts`

- [ ] **Step 1: Write failing HTTP test in `app.test.ts`**

```ts
it('deletes multiple reports in batch with POST /api/digests/batch-delete', async () => {
  const deleted: string[][] = [];
  runtimeServices.reports.removeBatch = async (ids) => {
    deleted.push(ids);
    return ids.length;
  };
  const response = await app.inject({
    method: 'POST',
    url: '/api/digests/batch-delete',
    headers: { cookie, 'x-csrf-token': csrfToken },
    payload: { ids: ['report-1', 'report-2'] }
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ deletedCount: 2 });
  expect(deleted).toEqual([['report-1', 'report-2']]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test backend/src/http/app.test.ts`
Expected: FAIL (404 Not Found on endpoint)

- [ ] **Step 3: Implement batch delete in persistence stores and `app.ts`**

In `sqlite-v2-stores.ts` and `runtime-persistence.ts`:
```ts
async removeBatch(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  let count = 0;
  for (const id of ids) {
    if (await this.remove(id)) count += 1;
  }
  return count;
}
```

In `app.ts`:
```ts
app.post('/api/digests/batch-delete', async (request, reply) => {
  const { ids } = BatchDeleteReportsRequestSchema.parse(request.body);
  const deletedCount = await options.services.reports.removeBatch(ids);
  return reply.code(200).send(BatchDeleteReportsResponseSchema.parse({ deletedCount }));
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test backend/src/http/app.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/persistence/sqlite-v2-stores.ts backend/src/runtime-persistence.ts backend/src/http/app.ts backend/src/http/app.test.ts
git commit -m "feat(backend): add POST /api/digests/batch-delete endpoint"
```

---

### Task 3: Add Frontend Multi-Selection UI, Batch Toolbar, and Confirmation Modal

**Files:**
- Modify: `frontend/src/api-client.ts`
- Modify: `frontend/src/report-history.tsx`
- Modify: `frontend/src/report-history.test.tsx` (or `app.test.tsx`)
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Add `deleteDigestsBatch` method to `api-client.ts`**

```ts
deleteDigestsBatch: (ids: string[]): Promise<BatchDeleteReportsResponse> =>
  request('/api/digests/batch-delete', BatchDeleteReportsResponseSchema, {
    method: 'POST',
    body: JSON.stringify(BatchDeleteReportsRequestSchema.parse({ ids }))
  }),
```

- [ ] **Step 2: Add failing UI test for batch selection and deletion**

In `report-history.test.tsx`:
```ts
it('allows selecting multiple reports and deleting them in batch', async () => {
  // Test checkboxes, select all toggle, batch toolbar rendering, and confirm deletion
});
```

- [ ] **Step 3: Update `report-history.tsx` and `styles.css`**

Add selection state (`selectedIds: Set<string>`), "Select All" toggle checkbox, per-row checkboxes, sticky/top batch action toolbar with count (`X seleccionados`) and "Eliminar seleccionados" button, confirmation dialog modal, and execution trigger `deleteDigestsBatch(Array.from(selectedIds))`.

- [ ] **Step 4: Run frontend tests and verify**

Run: `pnpm test frontend/src/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api-client.ts frontend/src/report-history.tsx frontend/src/styles.css
git commit -m "feat(frontend): add batch selection, toolbar, and confirmation modal for deleting reports"
```
