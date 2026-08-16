# Implementation Plan: AI Free Tier Rate Limiting & Transparent Error Reporting

## Problem Statement

1. **Rate Limit 429 on Gemini Free Tier**:
   - Google Gemini Free Tier imposes a limit of **15 to 20 Requests Per Minute (RPM)**.
   - When a report contains 41 unique signatures, `BatchReportRun` invokes `provider.analyze` 41 times back-to-back.
   - After 20 requests, Google Gemini returns `HTTP 429: Quota exceeded for metric: generate_content_free_tier_requests, limit: 20`.

2. **Opaque Error Messages**:
   - When AI analysis fails, the system logs `failedCount: 41` without preserving the exact API error details.
   - The UI shows generic fallback text ("La IA no pudo explicar este problema"), preventing users from knowing whether their API key is invalid or rate limited.

## Proposed Solution

### Task 1: Cap Signatures per AI Run & Add Gentle Pacing in Backend
- Modify `backend/src/application/batch-report-run.ts`:
  - Sort signatures by frequency/severity and take the top N (max 10) for AI analysis to remain safely under the Free Tier 15 RPM limit.
  - Insert a short delay (300ms) between AI provider calls.
  - Capture and log explicit AI provider errors (`AIProviderError.message` and `classification`).

### Task 2: Store Explicit AI Error Messages in Report Presentation
- Modify `packages/shared/src/dtos.ts` & `backend/src/application/batch-report-run.ts`:
  - Pass the explicit AI error message into `report.failure` or `report.aiErrorMessage` when AI analysis fails or rate-limits.

### Task 3: Render Transparent Error Alert in Frontend UI
- Modify `frontend/src/report-detail.tsx`, `frontend/src/i18n/locales/es.json` & `en.json`:
  - Show a prominent, clear alert header in report details when AI is rate limited (429) or fails:
    "⚠️ Error en la IA (HTTP 429): Límite de cuota gratuita superado (20 peticiones/min). Se muestra la información de Home Assistant."
