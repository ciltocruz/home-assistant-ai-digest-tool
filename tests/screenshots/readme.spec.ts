import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Generates README screenshots against the real frontend with a fully mocked
 * runtime API. Deterministic, credential-free, and identical to the smoke-test
 * harness: no backend, no secrets, no Home Assistant needed.
 *
 * Run with: pnpm screenshots
 * Output: docs/readme-screenshots/*.png
 */

const SENTINEL_HA = 'SENTINEL_HA_AUTH';
const SENTINEL_AI = 'SENTINEL_AI_KEY';
const SENTINEL_TELEGRAM = 'SENTINEL_TELEGRAM_TOKEN';
const SENTINEL_CSRF = 'SENTINEL_CSRF';
const SENTINEL_CHAT = 'SENTINEL_CHAT_ID';
const CREATED_AT = '2026-08-16T08:00:00.000Z';

type DemoState = {
  onboardingCompleted: boolean;
  hasAdmin: boolean;
  loggedIn: boolean;
  language: 'en' | 'es';
  history: Array<Record<string, unknown>>;
  presentations: Record<string, unknown>;
};

test('captures the operational screens for the public README', async ({ page }) => {
  const state: DemoState = {
    onboardingCompleted: true,
    hasAdmin: true,
    loggedIn: true,
    language: 'en',
    history: [
      digestSummary('report-morning', { critical: 1, warning: 2, info: 0, createdAt: '2026-08-16T06:00:00.000Z' }),
      digestSummary('report-evening', { critical: 0, warning: 0, info: 1, createdAt: '2026-08-15T18:00:00.000Z' }),
      digestSummary('report-night', { critical: 0, warning: 1, info: 2, createdAt: '2026-08-14T22:00:00.000Z' })
    ],
    presentations: {
      'report-morning': structuredPresentation()
    }
  };

  await mockRuntimeApi(page, state);
  await page.context().addCookies([{ name: 'ha_digest_session', value: 'demo-session', url: 'http://127.0.0.1:4173' }]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });

  // Dashboard with attention items, latest report, and history preview.
  await page.goto('/');
  await expect(page.locator('[data-dashboard-section="current-state"]')).toContainText('attention');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'docs/readme-screenshots/01-dashboard.png', fullPage: true });

  // Reports list with the detail workspace open on the structured report.
  await page.goto('/reports/report-morning');
  await expect(page.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /attention/i })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'docs/readme-screenshots/02-report-detail.png', fullPage: true });

  // Configuration: connection section with masked secrets.
  await page.goto('/settings');
  await expect(page.locator('#settings-connection')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'docs/readme-screenshots/03-configuration.png', fullPage: true });

  // Onboarding: guided setup start, language picker visible.
  state.onboardingCompleted = false;
  await page.goto('/');
  await expect(page.getByRole('form', { name: /guided setup|Configuración guiada/i })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'docs/readme-screenshots/04-onboarding.png', fullPage: true });
});

async function mockRuntimeApi(page: Page, state: DemoState): Promise<void> {
  await page.route('/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();

    if (url.pathname === '/api/auth/status' && request.method() === 'GET') return json(route, { hasAdmin: state.hasAdmin });
    if (url.pathname === '/api/session' && request.method() === 'GET') {
      return state.loggedIn
        ? json(route, { csrfToken: SENTINEL_CSRF, language: state.language })
        : json(route, { code: 'UNAUTHENTICATED', message: 'Sign in required.', requestId: 'demo' }, 401);
    }

    if (url.pathname === '/api/onboarding' && request.method() === 'GET') {
      return json(route, {
        currentStep: state.onboardingCompleted ? 'first_report' : 'home_assistant',
        completedSteps: state.onboardingCompleted ? ['home_assistant', 'ai_provider', 'notifications', 'schedule', 'privacy'] : [],
        draft: {},
        secretMetadata: {},
        completed: state.onboardingCompleted
      });
    }
    if (url.pathname === '/api/onboarding' && request.method() === 'PATCH') return json(route, { currentStep: body.step, completedSteps: [], draft: body.draft, secretMetadata: {}, completed: false });

    if (url.pathname === '/api/settings' && request.method() === 'GET') return json(route, settingsResponse());

    if (url.pathname === '/api/digests/history' && request.method() === 'GET') return json(route, state.history);

    if (url.pathname.startsWith('/api/digests/') && url.pathname !== '/api/digests/history' && request.method() === 'GET') {
      const id = url.pathname.split('/').at(-1) ?? 'unknown';
      const summary = state.history.find((item) => item.id === id);
      if (!summary) return json(route, { code: 'NOT_FOUND', message: 'Report missing.', requestId: 'demo' }, 404);
      return json(route, {
        id,
        summary,
        rendered: { format: 'markdown', body: 'Demo digest body.' },
        ...(state.presentations[id] ? { presentation: state.presentations[id] } : {})
      });
    }

    if (url.pathname === '/api/notes' && request.method() === 'GET') return json(route, []);
    if (url.pathname === '/api/ignores' && request.method() === 'GET') return json(route, []);

    return json(route, { code: 'NOT_FOUND', message: 'No demo route matched.', requestId: 'demo' }, 404);
  });
}

function settingsResponse(): Record<string, unknown> {
  return {
    homeAssistant: { url: 'http://homeassistant.local:8123', token: { configured: true, mask: '••••ha' } },
    ai: { provider: 'gemini', key: { configured: true, mask: '••••ai' } },
    notifications: { channel: 'telegram', chatId: SENTINEL_CHAT, botToken: { configured: true, mask: '••••tg' } },
    schedules: [{ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
    privacyLevel: 'balanced',
    retentionDays: 90
  };
}

function digestSummary(id: string, options: { critical: number; warning: number; info: number; createdAt: string }) {
  return {
    id,
    window: { from: '2026-08-14T00:00:00.000Z', to: options.createdAt },
    severityCounts: { critical: options.critical, warning: options.warning, info: options.info },
    createdAt: options.createdAt,
    deliveryStatus: 'sent'
  };
}

function structuredPresentation(): Record<string, unknown> {
  return {
    version: 1,
    mode: 'structured',
    overview: {
      title: 'Home Assistant Digest',
      detail: '3 conditions need attention since the last report.'
    },
    attention: [
      {
        id: 'attention-1',
        severity: 'critical',
        title: 'Zigbee coordinator unavailable',
        detail: 'No response from the coordinator for 2 hours. Devices keep their last state.'
      },
      {
        id: 'attention-2',
        severity: 'warning',
        title: 'MQTT connection restarted 5 times',
        detail: 'Reconnects every 20 minutes; broker or network instability.'
      },
      {
        id: 'attention-3',
        severity: 'warning',
        title: 'Garage door sensor battery low',
        detail: 'Reported 14% battery; expected to last 3 more weeks.'
      }
    ],
    observations: [
      {
        id: 'observations-1',
        severity: 'info',
        title: 'Hallway temperature',
        detail: 'Changed more often than usual during the night.'
      }
    ],
    allGood: [],
    recommendations: [
      {
        id: 'recommendation-1',
        severity: 'critical',
        title: 'Zigbee coordinator unavailable',
        detail: 'Restart the coordinator and verify the USB connection.'
      },
      {
        id: 'recommendation-2',
        severity: 'warning',
        title: 'MQTT connection restarted 5 times',
        detail: 'Check the broker address, credentials, and network stability.'
      }
    ],
    evidence: [
      {
        id: 'evidence-1',
        title: 'Reading window',
        detail: '2026-08-14 00:00 to 2026-08-16 08:00, 1,204 log lines, 12 signatures.'
      }
    ]
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body)
  });
}
