# Design Spec: Stale and Unavailable Entities Audit

## Purpose
Expose a real-time health check for Home Assistant devices and entities that are `unavailable`, `unknown`, or haven't updated state within a configurable window (default 24h). This allows users to catch broken Zigbee sensors, dead batteries, and offline integrations without waiting for an AI log report run.

## Requirements
1. **Backend HA Fetcher & Domain Logic**:
   - Query HA REST API `/api/states` or WebSocket states snapshot.
   - Filter entities:
     - `unavailable` or `unknown` state -> classified as `unavailable`.
     - `last_updated` older than 24 hours (or configurable threshold) for active sensor domains -> classified as `stale`.
   - Redact/mask any private entity names or tokens if configured in balanced privacy mode.

2. **Backend API Endpoint (`GET /api/entities/stale`)**:
   - Authenticated & CSRF-protected endpoint.
   - Shared DTO schema: `StaleEntitiesResponseSchema`.
   - Returns `{ unavailableCount: number, staleCount: number, totalAudited: number, entities: Array<EntityIssueDto> }`.

3. **Frontend UI Component**:
   - Add a "Dispositivos & Entidades" status card/tab on the Dashboard.
   - Filter tabs: `Todos`, `Sin respuesta (Unavailable)`, `Inactivos (Stale)`.
   - Search bar and domain filter badges (Zigbee, Sensor, Climate, Light, etc.).
   - Visual indicators showing state badge, last updated time ("hace 3 horas", "hace 2 días"), and direct entity ID.
   - Refresh button with live status feedback.
