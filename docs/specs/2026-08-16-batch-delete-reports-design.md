# Spec: Batch Selection and Deletion of Reports

## Overview
Allows users to select multiple historical reports from the UI history list and delete them in bulk with a single batch operation and confirmation dialog.

## User Interface & Behavior
1. **Selection Controls**:
   - Header checkbox to "Select All" / "Deselect All" visible items.
   - Individual checkbox next to each report card in the history list.
2. **Batch Action Toolbar**:
   - Appears when $\ge 1$ report is selected.
   - Displays count of selected reports (e.g. `2 informes seleccionados`).
   - Danger button: `Eliminar seleccionados`.
3. **Confirmation Modal**:
   - Asks for confirmation before deletion (`¿Eliminar X informes seleccionados?`).
   - `Eliminar` action performs bulk delete, resets selection, updates history list, and shows success feedback.
   - `Cancelar` closes modal without changes.

## Backend & API
1. **Endpoint**: `POST /api/digests/batch-delete`
   - Request Body: `{ ids: string[] }`
   - Response: `200 OK` with `{ deletedCount: number }`
   - Validates CSRF token and session authentication.
2. **Store & Persistence**:
   - Executes atomic SQL batch deletion for the requested IDs from `v2_reports` and legacy `reports`.
