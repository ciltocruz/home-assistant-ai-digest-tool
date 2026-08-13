import { expect, test, type Page, type Route } from '@playwright/test';

type MockState = {
  digestsQueued: number;
  ignores: Array<{ id: string; match: string; type: 'entity'; createdAt: string; reason?: string }>;
  notes: Array<{ id: string; text: string; occurredAt: string; createdAt: string; tags: string[] }>;
  notifierTests: number;
  settingsCommands: unknown[];
  onboardingDraft: Record<string, unknown>;
  completedOnboardingSteps: string[];
  onboardingCompleted: boolean;
  jobPhase: 0 | 1 | 2 | 3 | 4;
  savedSettings: Record<string, unknown>;
  history: Array<Record<string, unknown>>;
  historyFailure: boolean;
  reportPresentations: Record<string, unknown>;
  hasAdmin: boolean;
  loggedIn: boolean;
  language: 'en' | 'es';
  sessionCookieRequired: boolean;
};

const SMOKE_HA_AUTH_SENTINEL = 'SMOKE_SENTINEL_HA_AUTH_VALUE';
const SMOKE_AI_CREDENTIAL_SENTINEL = 'SMOKE_SENTINEL_AI_CREDENTIAL';
const SMOKE_TELEGRAM_CREDENTIAL_SENTINEL = 'SMOKE_SENTINEL_TELEGRAM_CREDENTIAL';
const SMOKE_CSRF_SENTINEL = 'SMOKE_SENTINEL_CSRF_VALUE';
const SMOKE_CHAT_ID_SENTINEL = 'SMOKE_CHAT_ID_VALUE';
const SMOKE_CREATED_AT = '2026-07-14T00:00:00.000Z';

const settings = {
  homeAssistant: { url: 'http://homeassistant.local:8123', token: { configured: true, mask: '••••ha' } },
  ai: { provider: 'gemini', key: { configured: true, mask: '••••ai' } },
  notifications: { channel: 'telegram', chatId: SMOKE_CHAT_ID_SENTINEL, botToken: { configured: true, mask: '••••telegram' } },
  schedules: [{ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
  privacyLevel: 'balanced',
  retentionDays: 90
} as const;

test('registers, signs in, completes onboarding, and runs the first deterministic manual digest', async ({ page }) => {
  const state = await mockRuntimeApi(page);
  state.hasAdmin = false; state.loggedIn = false;

  await page.goto('/');
  await page.getByLabel('Language').selectOption('es');
  await page.getByLabel('Contraseña').fill('smoke-account-password');
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  const onboarding = page.getByRole('form', { name: 'Configuración guiada' });
  await onboarding.getByLabel('URL de Home Assistant').fill('http://homeassistant.local:8123');
  await onboarding.getByLabel('Token de Home Assistant').fill(SMOKE_HA_AUTH_SENTINEL);
  await onboarding.getByRole('button', { name: 'Continuar a proveedor de IA' }).click();
  await onboarding.getByLabel('Clave API del proveedor').fill(SMOKE_AI_CREDENTIAL_SENTINEL);
  await onboarding.getByRole('button', { name: 'Continuar a canal de aviso' }).click();
  await onboarding.getByLabel('Token del bot de Telegram').fill(SMOKE_TELEGRAM_CREDENTIAL_SENTINEL);
  await onboarding.getByLabel('ID del chat de Telegram').fill(SMOKE_CHAT_ID_SENTINEL);
  await onboarding.getByRole('button', { name: 'Continuar al horario' }).click();
  await onboarding.getByLabel('Hora del informe').fill('09:15');
  await onboarding.getByLabel('Zona horaria').fill('Europe/Madrid');
  await onboarding.getByRole('button', { name: 'Continuar a privacidad' }).click();
  await onboarding.getByLabel('Días de retención').fill('45');
  await onboarding.getByLabel(/Acepto que los datos/).check();
  await onboarding.getByRole('button', { name: 'Continuar al primer informe' }).click();
  await onboarding.getByRole('button', { name: 'Validar y lanzar primer informe' }).click();

  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Panel', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(state.digestsQueued).toBe(1);
});

test('gates operations and preserves shell navigation', async ({ page }) => {
  const state = await mockRuntimeApi(page);

  await page.goto('/settings');
  await expect(page.getByRole('form', { name: 'Configuración guiada' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toHaveCount(0);

  state.onboardingCompleted = true;
  state.sessionCookieRequired = true;
  const resumedSession = page.waitForResponse((response) => {
    const request = response.request();
    return new URL(response.url()).pathname === '/api/session' && request.method() === 'GET';
  });
  await page.reload();
  const sessionResponse = await resumedSession;
  expect(sessionResponse.status()).toBe(200);
  expect((await sessionResponse.json()).csrfToken).toMatch(/\S+/);
  expect(sessionResponse.request().headers().cookie).toContain('ha_digest_session=smoke-session');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: 'Panel', exact: true })).toHaveAttribute('aria-current', 'page');

  await page.getByRole('link', { name: 'Informes', exact: true }).click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByRole('link', { name: 'Informes', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page.getByRole('link', { name: 'Panel', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('shows the empty history state and allows a manual digest from the dashboard', async ({ page }) => {
  const state = await mockRuntimeApi(page);
  state.onboardingCompleted = true;

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Sin incidencias pendientes' })).toBeVisible();
  await expect(page.getByText('Todavía no hay ningún informe guardado.')).toBeVisible();
  await page.getByRole('button', { name: 'Lanzar informe' }).click();
  await expect(page.getByRole('heading', { name: 'En cola' })).toBeVisible();
  expect(state.digestsQueued).toBe(1);
});

test('orders dashboard priorities and recovers history', async ({ page }) => {
  const state = await mockRuntimeApi(page);
  state.onboardingCompleted = true;
  state.history = [
    digestSummary('report-latest', { critical: 1, warning: 2, info: 0, createdAt: '2026-08-01T10:00:00.000Z' }),
    digestSummary('report-previous', { critical: 0, warning: 0, info: 1, createdAt: '2026-08-01T09:00:00.000Z' })
  ];

  await page.goto('/');
  await expect(page.locator('[data-dashboard-section="current-state"]')).toContainText('3 incidencias requieren atención');
  await expect(page.locator('[data-dashboard-section="latest-report"]')).toContainText('Último informe');
  await expect(page.locator('[data-dashboard-section="history-preview"]')).toContainText('1 informe anterior');
  expect(await page.locator('[data-dashboard-section]').evaluateAll((sections) => sections.map((section) => section.getAttribute('data-dashboard-section')))).toEqual([
    'current-state', 'active-report', 'latest-report', 'history-preview'
  ]);

  state.historyFailure = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No se pudo actualizar el estado' })).toBeVisible();
  state.historyFailure = false;
  await page.getByRole('button', { name: 'Reintentar estado' }).click();
  await expect(page.locator('[data-dashboard-section="latest-report"]')).toContainText('Críticas 1');
});

test('opens report deep links, preserves browser navigation, and presents legacy Markdown safely', async ({ page }) => {
  const state = await mockRuntimeApi(page);
  state.onboardingCompleted = true;
  state.history = [digestSummary('report-latest', { critical: 1, warning: 0, info: 1, createdAt: '2026-08-01T10:00:00.000Z' })];

  await page.goto('/reports');
  const reportLink = page.getByRole('link', { name: 'Abrir informe del 1 ago 2026, 12:00' });
  await expect(reportLink).toBeVisible();
  await reportLink.click();
  await expect(page).toHaveURL(/\/reports\/report-latest$/);
  await expect(page.getByRole('heading', { name: 'Detalle del informe' })).toBeVisible();
  await expect(page.getByText('report-latest', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Resumen de severidad' })).toBeVisible();
  await expect(page.locator('pre')).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByRole('link', { name: 'Abrir informe del 1 ago 2026, 12:00' })).toBeVisible();
  await page.goto('/reports/missing-report');
  await expect(page.getByRole('heading', { name: 'Informe no encontrado' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Volver a informes' })).toHaveAttribute('href', '/reports');
});

test('renders structured and legacy reports', async ({ page }) => {
  const state = await mockRuntimeApi(page);
  state.onboardingCompleted = true;
  state.history = [digestSummary('report-structured', { critical: 1, warning: 0, info: 1, createdAt: '2026-08-01T10:00:00.000Z' })];
  state.reportPresentations['report-structured'] = {
    version: 1,
    mode: 'structured',
    overview: { title: 'Home Assistant Digest', detail: 'One condition needs review.' },
    attention: [{ id: 'attention-1', severity: 'critical', title: 'Garage door sensor', detail: 'Unavailable for 3 hours.' }],
    observations: [{ id: 'observations-1', severity: 'info', title: 'Hallway temperature', detail: 'Changed more often than usual.' }],
    allGood: [],
    recommendations: [{ id: 'recommendation-1', severity: 'critical', title: 'Garage door sensor', detail: 'Unavailable for 3 hours.' }],
    evidence: [{ id: 'evidence-1', title: 'Recorder window', detail: 'No gaps were reported.' }]
  };

  const reportResponse = page.waitForResponse('**/api/digests/report-structured');
  await page.goto('/reports/report-structured');
  expect(await (await reportResponse).json()).toHaveProperty('presentation.mode', 'structured');
  await expect(page.getByRole('heading', { name: 'Resumen', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Requiere atención' })).toBeVisible();
  await expect(page.getByLabel('Requiere atención').getByText('Crítica', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recomendación' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Evidencia' })).toBeVisible();

  await page.goto('/reports/report-legacy');
  await expect(page.getByRole('heading', { name: 'Informe importado (formato anterior)' })).toBeVisible();
  await expect(page.getByText('Este informe se generó con una versión anterior y no contiene un análisis de IA estructurado por problema detectado.')).toBeVisible();
  const legacyDisclosure = page.locator('details.report-legacy-disclosure');
  await expect(legacyDisclosure).toHaveCount(1);
  expect(await legacyDisclosure.getAttribute('open')).toBeNull();
  await legacyDisclosure.locator('summary').click();
  await expect(legacyDisclosure).toContainText('Datos protegidos ocultos');
  await expect(legacyDisclosure.locator('script')).toHaveCount(0);
  await expect(page.locator('pre')).toHaveCount(0);
});

test('keeps selected report reading order and responsive layout through live resizing', async ({ page }) => {
  const state = await mockRuntimeApi(page);
  state.onboardingCompleted = true;
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/reports/report-latest');
  const detail = page.locator('.report-detail-card, .report-detail');
  const history = page.locator('.history-panel');
  await expect(detail).toBeVisible();
  await expect(history).toBeVisible();
  const detailBox = await detail.boundingBox();
  const historyBox = await history.boundingBox();

  expect(detailBox?.y).toBeLessThan(historyBox?.y ?? Number.POSITIVE_INFINITY);
  expect(await page.locator('.reports-workspace > *').evaluateAll((items) => items.map((item) => item.className))).toEqual(expect.arrayContaining([expect.stringContaining('report-detail'), expect.stringContaining('history-panel')]));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => document.documentElement.clientWidth));

  await page.setViewportSize({ width: 1000, height: 844 });
  const tabletDetail = await detail.boundingBox();
  const tabletHistory = await history.boundingBox();
  expect(tabletDetail?.y).toBeLessThan(tabletHistory?.y ?? Number.POSITIVE_INFINITY);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => document.documentElement.clientWidth));

  await page.setViewportSize({ width: 1500, height: 900 });
  const desktopDetail = await detail.boundingBox();
  const desktopHistory = await history.boundingBox();
  expect(desktopDetail?.x).toBeLessThan(desktopHistory?.x ?? Number.POSITIVE_INFINITY);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => document.documentElement.clientWidth));
});

test('uses the full reports workspace when no detail is selected', async ({ page }) => {
  const state = await mockRuntimeApi(page);
  state.onboardingCompleted = true;
  state.history = [digestSummary('report-latest', { critical: 1, warning: 0, info: 1, createdAt: '2026-08-01T10:00:00.000Z' })];
  await page.setViewportSize({ width: 1500, height: 900 });

  await page.goto('/reports');

  const workspace = await page.locator('.reports-workspace').boundingBox();
  const history = await page.locator('.history-panel').boundingBox();
  expect(history?.width).toBeGreaterThan((workspace?.width ?? 0) * 0.95);
});

test('deletes a report only after confirmation and returns to refreshed history', async ({ page }) => {
  const state = await mockRuntimeApi(page);
  state.onboardingCompleted = true;
  state.history = [
    digestSummary('report-selected', { critical: 1, warning: 0, info: 0, createdAt: '2026-08-01T10:00:00.000Z' }),
    digestSummary('report-neighbor', { critical: 0, warning: 1, info: 0, createdAt: '2026-08-01T09:00:00.000Z' })
  ];

  await page.goto('/reports/report-selected');
  await page.getByRole('button', { name: 'Eliminar informe' }).click();
  const dialog = page.getByRole('dialog', { name: 'Eliminar informe' });
  await expect(dialog).toContainText('Esta acción no se puede deshacer');
  await dialog.getByRole('button', { name: 'Eliminar informe' }).click();

  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByRole('link', { name: /Abrir informe del/ })).toHaveCount(1);
  expect(state.history.map((item) => item.id)).toEqual(['report-neighbor']);
});

test('keeps configuration controls off the dashboard and routes to configuration', async ({ page }) => {
  const state = await mockRuntimeApi(page);
  state.onboardingCompleted = true;

  await page.goto('/');
  await expect(page.getByText('Notas del operador')).toHaveCount(0);
  await expect(page.getByText('Avisos ignorados')).toHaveCount(0);
  await page.getByRole('link', { name: 'Configuración', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Conexiones, horario y privacidad' })).toBeVisible();
});

test('confirms ignore removal and passes keyboard flow', async ({ page }) => {
  const state = await mockRuntimeApi(page);
  state.onboardingCompleted = true;
  state.ignores = [{ id: 'ignore-1', match: 'sensor.ruidoso', type: 'entity', createdAt: SMOKE_CREATED_AT }];

  await page.goto('/settings?section=context');
  await expect(page.getByRole('link', { name: 'Contexto', exact: true })).toHaveAttribute('aria-current', 'page');
  const remove = page.getByTestId('remove-ignore-ignore-1');
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Quitar aviso ignorado' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Quitar' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();

  await remove.click();
  await dialog.getByRole('button', { name: 'Quitar' }).click();
  await expect(page.getByText('El aviso ignorado se quitó correctamente.')).toBeVisible();
  await expect(page.getByText('sensor.ruidoso')).toHaveCount(0);
});

test('shows only the selected settings section and follows section navigation', async ({ page }) => {
  const state = await mockRuntimeApi(page);
  state.onboardingCompleted = true;

  await page.goto('/settings');
  await expect(page.locator('#settings-connection')).toBeVisible();
  await expect(page.locator('#settings-ai')).toHaveCount(0);
  await expect(page.locator('#settings-context')).toHaveCount(0);

  await page.getByRole('link', { name: 'Proveedor de IA', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?section=ai$/);
  await expect(page.locator('#settings-ai')).toBeVisible();
  await expect(page.locator('#settings-connection')).toHaveCount(0);
  await expect(page.locator('#settings-context')).toHaveCount(0);

  await page.getByRole('link', { name: 'Contexto', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?section=context$/);
  await expect(page.locator('#settings-context')).toBeVisible();
  await expect(page.locator('.settings-form')).toHaveCount(0);
  await expect(page.locator('#settings-ai')).toHaveCount(0);
});

test('rotates settings secrets without preloading or reflecting their raw values', async ({ page }) => {
  const state = await mockRuntimeApi(page);
  state.onboardingCompleted = true;
  const replacement = 'SMOKE_REPLACEMENT_AI_KEY';

  await page.goto('/settings?section=ai');
  const panel = page.locator('.settings-panel');
  await expect(panel.getByText('••••AI')).toBeVisible();
  await expect(panel.locator('input[name="aiKey"]')).toHaveCount(0);
  await panel.locator('input[value="replace-ai-key"]').check();
  await panel.locator('input[name="aiKey"]').fill(replacement);
  await panel.getByRole('button', { name: 'Guardar ajustes' }).click();

  expect(state.settingsCommands).toEqual([expect.objectContaining({ ai: { provider: 'gemini', key: { operation: 'replace', value: replacement } } })]);
  await expect(panel).not.toContainText(replacement);
});

test('persists onboarding, settings, and the queued-to-report lifecycle across browser reloads', async ({ page }) => {
  const state = await mockRuntimeApi(page);

  await page.goto('/');
  await completeOnboarding(page);
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible();

  await page.goto('/settings?section=privacy');
  const settingsPanel = page.locator('.settings-panel');
  await settingsPanel.getByLabel('Días de retención').fill('45');
  await settingsPanel.getByRole('button', { name: 'Guardar ajustes' }).click();
  expect(state.settingsCommands).toContainEqual(expect.objectContaining({ retentionDays: 45 }));
  await page.reload();
  await expect(page.getByLabel('Días de retención')).toHaveValue('45');

  await page.goto('/');
  await page.getByRole('button', { name: 'Lanzar informe' }).click();
  await expect(page.getByRole('heading', { name: 'En cola' })).toBeVisible();

  state.jobPhase = 1;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'En curso' })).toBeVisible();
  await expect(page.getByText('Se están recopilando los datos necesarios.')).toBeVisible();

  state.jobPhase = 2;
  await page.reload();
  await expect(page.getByText('Se está preparando el resumen con la configuración guardada.')).toBeVisible();

  state.jobPhase = 3;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Fallido' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Revise la conexión y el token');
  await page.getByRole('button', { name: 'Reintentar informe' }).click();
  await expect(page.getByRole('heading', { name: 'En cola' })).toBeVisible();

  state.jobPhase = 4;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Completado' })).toBeVisible();
  await page.getByRole('link', { name: 'Ver informe', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Detalle del informe' })).toBeVisible();
  await expect(page.getByText('smoke-report-2', { exact: true })).toBeVisible();
});

async function mockRuntimeApi(page: Page): Promise<MockState> {
  const state: MockState = {
    digestsQueued: 0,
    ignores: [],
    notes: [],
    notifierTests: 0,
    settingsCommands: [],
    onboardingDraft: {},
    completedOnboardingSteps: [],
    onboardingCompleted: false,
    jobPhase: 0,
    savedSettings: settingsResponse(),
    history: [],
    historyFailure: false,
    reportPresentations: {},
    hasAdmin: true,
    loggedIn: true,
    language: 'es',
    sessionCookieRequired: false
  };

  await page.route('/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();

    if (url.pathname === '/api/auth/status' && request.method() === 'GET') return json(route, { hasAdmin: state.hasAdmin });
    if (url.pathname === '/api/auth/register' && request.method() === 'POST') { state.hasAdmin = true; state.loggedIn = true; state.language = body.language; return json(route, { csrfToken: SMOKE_CSRF_SENTINEL, language: state.language }); }
    if (url.pathname === '/api/session' && request.method() === 'POST') { state.loggedIn = true; return json(route, { csrfToken: SMOKE_CSRF_SENTINEL, language: state.language }); }
    if (url.pathname === '/api/session' && request.method() === 'GET') {
      const hasSessionCookie = (request.headers()['cookie'] ?? '').includes('ha_digest_session=smoke-session');
      return state.loggedIn && (!state.sessionCookieRequired || hasSessionCookie)
        ? json(route, { csrfToken: SMOKE_CSRF_SENTINEL, language: state.language })
        : json(route, { code: 'UNAUTHENTICATED', message: 'Sign in required.', requestId: 'smoke' }, 401);
    }

    if (url.pathname === '/api/onboarding' && request.method() === 'GET') return json(route, onboardingProgress(state));
    if (url.pathname === '/api/onboarding' && request.method() === 'PATCH') {
      state.onboardingDraft = { ...state.onboardingDraft, ...body.draft };
      state.completedOnboardingSteps = [...new Set([...state.completedOnboardingSteps, body.step])];
      return json(route, onboardingProgress(state, body.step));
    }
    if (url.pathname === '/api/onboarding/complete' && request.method() === 'POST') {
      state.onboardingCompleted = true;
      return json(route, { csrfToken: SMOKE_CSRF_SENTINEL, settings: { haUrl: 'http://homeassistant.local:8123', ai: { provider: 'gemini', keyMask: 'configured', ref: 'ref:ai' }, notifiers: [] } });
    }

    if (url.pathname === '/api/settings' && request.method() === 'GET') return json(route, state.savedSettings);
    if (url.pathname === '/api/settings' && request.method() === 'PUT') {
      state.settingsCommands.push(body);
      state.savedSettings = settingsResponse(body);
      return json(route, state.savedSettings);
    }
    if (url.pathname === '/api/digests/run' && request.method() === 'POST') {
      state.digestsQueued += 1;
      return json(route, { status: 'queued', jobId: `smoke-job-${state.digestsQueued}` }, 202);
    }
    if (url.pathname.startsWith('/api/digests/jobs/') && request.method() === 'GET') {
      return json(route, jobStatus(url.pathname.split('/').at(-1) ?? 'unknown', state.jobPhase));
    }
    if (url.pathname.startsWith('/api/digests/jobs/') && url.pathname.endsWith('/retry') && request.method() === 'POST') {
      const id = url.pathname.split('/').at(-2) ?? 'unknown';
      state.jobPhase = 0;
      return json(route, jobStatus(id, state.jobPhase), 202);
    }
    if (url.pathname.startsWith('/api/digests/') && url.pathname !== '/api/digests/history' && request.method() === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice('/api/digests/'.length));
      state.history = state.history.filter((item) => item.id !== id);
      return route.fulfill({ status: 204, body: '' });
    }
    if (url.pathname.startsWith('/api/digests/') && url.pathname !== '/api/digests/history' && request.method() === 'GET') {
      const id = url.pathname.split('/').at(-1) ?? 'unknown';
      if (id === 'missing-report') return json(route, { code: 'NOT_FOUND', message: 'Report missing.', requestId: 'smoke' }, 404);
      const body = id === 'report-legacy'
        ? '# Legacy report\n\nredacted [REDACTED] REDACTED\n\n<script>no execute</script>'
        : `# Digest ${id}`;
      return json(route, { id, summary: { id, window: { from: '2026-07-13T23:59:59.999Z', to: SMOKE_CREATED_AT }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: SMOKE_CREATED_AT, deliveryStatus: 'pending' }, rendered: { format: 'markdown', body }, ...(state.reportPresentations[id] ? { presentation: state.reportPresentations[id] } : {}) });
    }
    if (url.pathname === '/api/digests/history' && request.method() === 'GET') {
      if (state.historyFailure) return json(route, { code: 'HISTORY_FAILED', message: 'History unavailable.', requestId: 'smoke' }, 503);
      return json(route, state.history);
    }
    if (url.pathname === '/api/notes' && request.method() === 'GET') return json(route, state.notes);
    if (url.pathname === '/api/notes' && request.method() === 'POST') {
      const note = { id: `note-${state.notes.length + 1}`, text: body.text, occurredAt: body.occurredAt, createdAt: SMOKE_CREATED_AT, tags: body.tags ?? [] };
      state.notes.unshift(note);
      return json(route, note, 201);
    }
    if (url.pathname === '/api/ignores' && request.method() === 'GET') return json(route, state.ignores);
    if (url.pathname === '/api/ignores' && request.method() === 'POST') {
      const rule = { id: `ignore-${state.ignores.length + 1}`, match: body.match, type: body.type ?? 'entity', reason: body.reason, createdAt: SMOKE_CREATED_AT };
      state.ignores.unshift(rule);
      return json(route, rule, 201);
    }
    if (url.pathname.startsWith('/api/ignores/') && request.method() === 'DELETE') {
      const id = url.pathname.split('/').at(-1);
      state.ignores = state.ignores.filter((rule) => rule.id !== id);
      return json(route, { removed: true });
    }
    if (url.pathname === '/api/notifiers/test-current' && request.method() === 'POST') {
      state.notifierTests += 1;
      return json(route, { status: 'success', message: 'Preview Telegram test accepted.', checkedAt: SMOKE_CREATED_AT });
    }

    return json(route, { code: 'NOT_FOUND', message: 'No smoke route matched.', requestId: 'smoke' }, 404);
  });

  await page.context().addCookies([{ name: 'ha_digest_session', value: 'smoke-session', url: 'http://127.0.0.1:4173' }]);

  return state;
}

function onboardingProgress(state: MockState, savedStep?: string) {
  const steps = ['home_assistant', 'ai_provider', 'notifications', 'schedule', 'privacy', 'first_report'];
  const currentIndex = state.onboardingCompleted
    ? steps.length - 1
    : Math.min(state.completedOnboardingSteps.length, steps.length - 1);
  return {
    currentStep: steps[currentIndex],
    completedSteps: state.completedOnboardingSteps,
    draft: state.onboardingDraft,
    secretMetadata: {},
    completed: state.onboardingCompleted
  };
}

async function completeOnboarding(page: Page) {
  const onboarding = page.getByRole('form', { name: 'Configuración guiada' });
  await onboarding.getByLabel('URL de Home Assistant').fill('http://homeassistant.local:8123');
  await onboarding.getByLabel('Token de Home Assistant').fill(SMOKE_HA_AUTH_SENTINEL);
  await onboarding.getByRole('button', { name: 'Continuar a proveedor de IA' }).click();
  await onboarding.getByLabel('Clave API del proveedor').fill(SMOKE_AI_CREDENTIAL_SENTINEL);
  await onboarding.getByRole('button', { name: 'Continuar a canal de aviso' }).click();
  await onboarding.getByLabel('Token del bot de Telegram').fill(SMOKE_TELEGRAM_CREDENTIAL_SENTINEL);
  await onboarding.getByLabel('ID del chat de Telegram').fill(SMOKE_CHAT_ID_SENTINEL);
  await onboarding.getByRole('button', { name: 'Continuar al horario' }).click();
  await onboarding.getByLabel('Hora del informe').fill('09:15');
  await onboarding.getByLabel('Zona horaria').fill('Europe/Madrid');
  await onboarding.getByRole('button', { name: 'Continuar a privacidad' }).click();
  await onboarding.getByLabel('Días de retención').fill('45');
  await onboarding.getByLabel(/Acepto que los datos/).check();
  await onboarding.getByRole('button', { name: 'Continuar al primer informe' }).click();
  await onboarding.getByRole('button', { name: 'Validar y lanzar primer informe' }).click();
}

function settingsResponse(command?: any): Record<string, unknown> {
  return {
    homeAssistant: { url: command?.homeAssistant?.url ?? settings.homeAssistant.url, token: settings.homeAssistant.token },
    ai: { provider: command?.ai?.provider ?? settings.ai.provider, key: settings.ai.key },
    notifications: settings.notifications,
    schedules: command?.schedules ?? settings.schedules,
    privacyLevel: command?.privacyLevel ?? settings.privacyLevel,
    retentionDays: command?.retentionDays ?? settings.retentionDays
  };
}

function jobStatus(id: string, phase: MockState['jobPhase']) {
  const base = { id, attempts: phase === 4 ? 2 : 1, retryCount: phase === 4 ? 1 : 0, retryAvailable: false, createdAt: SMOKE_CREATED_AT, updatedAt: SMOKE_CREATED_AT };
  if (phase === 0) return { ...base, status: 'queued', stage: 'queued' };
  if (phase === 1) return { ...base, status: 'running', stage: 'collecting' };
  if (phase === 2) return { ...base, status: 'running', stage: 'generating' };
  if (phase === 3) return { ...base, status: 'failed', stage: 'failed', retryAvailable: true, errorCode: 'HOME_ASSISTANT_UNAVAILABLE', errorMessage: 'No se pudieron recopilar datos de Home Assistant. Revise la conexión y el token.' };
  return { ...base, status: 'completed', stage: 'completed', reportId: 'smoke-report-2' };
}

function digestSummary(id: string, options: { critical: number; warning: number; info: number; createdAt: string }) {
  return {
    id,
    window: { from: '2026-08-01T08:00:00.000Z', to: options.createdAt },
    severityCounts: { critical: options.critical, warning: options.warning, info: options.info },
    createdAt: options.createdAt,
    deliveryStatus: 'sent'
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body)
  });
}
