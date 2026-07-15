import { expect, test, type Page, type Route } from '@playwright/test';

type MockState = {
  digestsQueued: number;
  ignores: Array<{ id: string; match: string; type: 'entity'; createdAt: string; reason?: string }>;
  notes: Array<{ id: string; text: string; occurredAt: string; createdAt: string; tags: string[] }>;
  notifierTests: number;
};

const SMOKE_SETUP_SENTINEL = 'SMOKE_SENTINEL_SETUP_ACCESS';
const SMOKE_HA_AUTH_SENTINEL = 'SMOKE_SENTINEL_HA_AUTH_VALUE';
const SMOKE_AI_CREDENTIAL_SENTINEL = 'SMOKE_SENTINEL_AI_CREDENTIAL';
const SMOKE_TELEGRAM_CREDENTIAL_SENTINEL = 'SMOKE_SENTINEL_TELEGRAM_CREDENTIAL';
const SMOKE_CSRF_SENTINEL = 'SMOKE_SENTINEL_CSRF_VALUE';
const SMOKE_CHAT_ID_SENTINEL = 'SMOKE_CHAT_ID_VALUE';
const SMOKE_CREATED_AT = '2026-07-14T00:00:00.000Z';

const settings = {
  haUrl: 'http://homeassistant.local:8123',
  aiProvider: 'gemini',
  secretRefs: {
    haTokenRef: 'ref:ha',
    aiKeyRef: 'ref:ai',
    notifierRefs: { telegram: 'ref:telegram' }
  },
  schedules: [{ kind: 'daily', enabled: true, time: '08:00', timezone: 'Europe/Madrid' }],
  privacyLevel: 'balanced',
  retentionDays: 90
} as const;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((setupToken) => {
    window.__HA_DIGEST_BOOTSTRAP__ = { setupToken };
  }, SMOKE_SETUP_SENTINEL);
});

test('completes onboarding and queues the first manual digest without live integrations', async ({ page }) => {
  const state = await mockRuntimeApi(page);

  await page.goto('/');
  const onboarding = page.getByRole('form', { name: 'Configuración guiada' });
  await onboarding.getByLabel('URL de Home Assistant').fill('http://homeassistant.local:8123');
  await onboarding.getByLabel('Token de Home Assistant').fill(SMOKE_HA_AUTH_SENTINEL);
  await onboarding.getByLabel('Clave del proveedor').fill(SMOKE_AI_CREDENTIAL_SENTINEL);
  await onboarding.getByLabel('Token del bot de Telegram').fill(SMOKE_TELEGRAM_CREDENTIAL_SENTINEL);
  await onboarding.getByLabel('ID del chat de Telegram').fill(SMOKE_CHAT_ID_SENTINEL);
  await onboarding.getByLabel('Hora del informe').fill('09:15');
  await onboarding.getByLabel('Zona horaria').fill('Europe/Madrid');
  await onboarding.getByLabel('Días de retención').fill('45');
  await onboarding.getByRole('button', { name: 'Continuar a proveedor de IA' }).click();
  await onboarding.getByRole('button', { name: 'Continuar a canal de aviso' }).click();
  await onboarding.getByRole('button', { name: 'Continuar a horario y privacidad' }).click();
  await onboarding.getByRole('button', { name: 'Continuar a primer informe' }).click();
  await onboarding.getByRole('button', { name: 'Validar y lanzar primer informe' }).click();

  await expect(onboarding.getByRole('button', { name: 'Primer informe en cola' })).toBeVisible();
  expect(state.digestsQueued).toBe(1);
});

test('shows the empty history state and allows a manual digest from the dashboard', async ({ page }) => {
  const state = await mockRuntimeApi(page);

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Aún no hay informes' })).toBeVisible();
  await page.getByRole('button', { name: 'Lanzar informe' }).click();
  await expect(page.getByText('Informe manual en cola.')).toBeVisible();
  expect(state.digestsQueued).toBe(1);
});

test('adds notes, ignore rules, and sends a Telegram test through fake API responses', async ({ page }) => {
  const state = await mockRuntimeApi(page);

  await page.goto('/');
  await page.getByLabel('Añadir nota').getByLabel('Nota').fill('Kitchen humidity sensor replaced.');
  await page.getByRole('button', { name: 'Guardar nota' }).click();
  await expect(page.getByText('Kitchen humidity sensor replaced.')).toBeVisible();

  await page.getByLabel('Añadir aviso ignorado').getByLabel('Coincidencia').fill('sensor.kitchen_humidity');
  await page.getByRole('button', { name: 'Ignorar aviso' }).click();
  await expect(page.getByText('sensor.kitchen_humidity')).toBeVisible();

  await page.getByRole('button', { name: 'Enviar prueba' }).click();
  await expect(page.getByText('Preview Telegram test accepted.')).toBeVisible();
  expect(state.notes).toHaveLength(1);
  expect(state.ignores).toHaveLength(1);
  expect(state.notifierTests).toBe(1);
});

async function mockRuntimeApi(page: Page): Promise<MockState> {
  const state: MockState = { digestsQueued: 0, ignores: [], notes: [], notifierTests: 0 };

  await page.route('/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();

    if (url.pathname === '/api/setup' && request.method() === 'POST') {
      return json(route, {
        csrfToken: SMOKE_CSRF_SENTINEL,
        settings: {
          haUrl: body.haUrl,
          ai: { provider: body.aiProvider, keyMask: 'configured', ref: 'ref:ai' },
          notifiers: [{ id: 'telegram', channel: 'telegram', targetRef: 'ref:telegram', label: 'Telegram', secretMask: 'configured' }]
        }
      });
    }

    if (url.pathname === '/api/settings' && request.method() === 'GET') return json(route, settings);
    if (url.pathname === '/api/settings' && request.method() === 'PUT') return json(route, body);
    if (url.pathname === '/api/digests/run' && request.method() === 'POST') {
      state.digestsQueued += 1;
      return json(route, { status: 'queued', jobId: `smoke-job-${state.digestsQueued}` });
    }
    if (url.pathname === '/api/digests/history' && request.method() === 'GET') return json(route, []);
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
    if (url.pathname === '/api/notifiers/test' && request.method() === 'POST') {
      state.notifierTests += 1;
      return json(route, { status: 'success', message: 'Preview Telegram test accepted.', checkedAt: SMOKE_CREATED_AT });
    }

    return json(route, { code: 'NOT_FOUND', message: 'No smoke route matched.', requestId: 'smoke' }, 404);
  });

  return state;
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body)
  });
}
