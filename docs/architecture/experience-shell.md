# Experience shell

## Operational shell

After the six-screen onboarding is complete, the application exposes three URL-addressable areas: Dashboard (`/`), Reports (`/reports` and `/reports/:id`), and Configuration (`/settings?section=`). The active area survives reload and browser back/forward navigation. Incomplete onboarding redirects operational URLs to `/setup`; a completed setup redirects `/setup` to the Dashboard.

Dashboard is an operational summary only. It presents current status and attention first, then an active report job, the latest report, and a short history preview. It does not contain configuration or maintenance mutations.

## Configuration ownership

Configuration is the sole owner of the Home Assistant connection, AI provider, notification channel, schedule, privacy, retention, operator notes, and ignored-warning rules. Its section links are shareable URLs. Saved secrets remain masked; replace operations require an explicit new value.

Settings validate before saving, show inline recovery guidance, provide a cancel action for unsaved edits, and warn the browser before leaving a dirty form. Testing a Telegram notification is also a Configuration action. Removing an ignored warning opens a keyboard-accessible confirmation dialog; cancellation changes nothing, while a failed confirmed removal preserves the rule and offers a safe retry.

## Reports and lifecycle

Reports owns the full history and report detail. Selecting a history item opens `/reports/:id`; the same URL is safe to reload and a missing report provides a return path to Reports. Desktop keeps history and a selected detail together, while mobile places the selected detail first.

A manual report creates a persisted job. The Dashboard exposes queued, running, failed, retry, and completed states, and the completed state links to the saved report. Reloading the browser does not reset job or report state because the backend remains the source of truth.

## Accessibility and recovery

The shell uses semantic navigation, a skip link, visible focus states, 44px minimum touch targets, safe-area padding, reduced-motion handling, and `Intl` formatting for dates. Loading, empty, failure, retry, and success feedback use neutral Spanish and preserve the current route. Dialog focus is trapped while open, Escape cancels it, and focus returns to the action that opened it.
