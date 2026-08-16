import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test } from 'vitest';
import { ReportDetail } from './report-detail.js';
import { setLocale } from './i18n/index.js';

beforeEach(() => setLocale('es'));

describe('ReportDetail', () => {
  test('renders a completed report from its durable report identifier', () => {
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'report-9',
      summary: { id: 'report-9', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 1, warning: 0, info: 2 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'sent' },
      rendered: { format: 'markdown', body: '# Informe\n\nUna incidencia crítica.' }
    }} />);

    expect(html).toContain('Detalle del informe');
    expect(html).toContain('report-9');
    expect(html).toContain('Una incidencia crítica.');
    expect(html).toContain('Resumen de severidad');
    expect(html).toContain('Críticas 1');
    expect(html).toContain('Avisos 0');
    expect(html).toContain('Observaciones 2');
    expect(html).toContain('Volver a informes');
    expect(html).toContain('Periodo revisado');
    expect(html).toContain('Intervalo de información de Home Assistant revisado para crear este informe.');
    expect(html).not.toContain('Origen');
    expect(html).not.toContain('<pre>');
  });

  test('keeps legacy Markdown behind a collapsed disclosure and protects repeated markers', () => {
    setLocale('es');
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'report-legacy',
      summary: { id: 'report-legacy', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'skipped' },
       rendered: { format: 'markdown', body: '# Informe heredado\n\n- Sensor estable\n- redacted [REDACTED] REDACTED\n- <script>no ejecutar</script>' }
    }} />);

    expect(html).toContain('Informe importado (formato anterior)</h2>');
    expect(html).toContain('<li>Sensor estable</li>');
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
    expect(html).toContain('Este informe se generó con una versión anterior y no contiene un análisis de IA estructurado por problema detectado.');
    expect(html).toContain('Solo un informe nuevo puede proporcionar ese análisis.');
    expect(html).toContain('Mostrar el contenido original del informe');
    expect(html.match(/Datos protegidos ocultos/g)).toHaveLength(1);
    expect(html).toContain('&lt;script&gt;no ejecutar&lt;/script&gt;');
    expect(html).toContain('Informe importado (formato anterior)');
    expect(html).not.toContain('<script>');
  });

  test.each([
    { locale: 'en' as const, label: 'Report generated at' },
    { locale: 'es' as const, label: 'Informe generado el' }
  ])('labels a synthetic v2 point-in-time window honestly in $locale', ({ locale, label }) => {
    setLocale(locale);
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: `v2-point-in-time-${locale}`,
      source: 'v2',
      summary: { id: `v2-point-in-time-${locale}`, window: { from: '2026-08-01T09:59:59.999Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'quiet' },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'quiet', warnings: [], signatures: [] }
    }} />);

    expect(html).toContain(`<dt>${label}</dt>`);
    expect(html).not.toContain(locale === 'es' ? 'Periodo revisado' : 'Reviewed period');
  });

  test.each([
    { source: 'legacy' as const, presentation: undefined },
    { source: 'v2' as const, presentation: { version: 2 as const, mode: 'batch' as const, status: 'quiet' as const, warnings: [], signatures: [] } }
  ])('renders $source detail timestamps in the configured schedule timezone', ({ source, presentation }) => {
    const html = renderToStaticMarkup(<ReportDetail timeZone="Europe/Madrid" report={{
      id: `${source}-timezone`,
      source,
      summary: { id: `${source}-timezone`, window: { from: '2026-08-13T20:15:00.000Z', to: '2026-08-13T21:15:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-13T21:15:00.000Z', deliveryStatus: 'skipped', source, ...(source === 'v2' ? { runStatus: 'quiet' as const } : {}) },
      rendered: { format: 'markdown', body: '# Report' },
      ...(presentation ? { presentation } : {})
    }} />);

    expect(html).toContain('13 ago 2026, 23:15');
    expect(html).toContain('13 ago 2026, 23:15');
  });

  test('reserves reviewed-period metadata for legacy report windows', () => {
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'v2-wide-fixture',
      source: 'v2',
      summary: { id: 'v2-wide-fixture', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'quiet' },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'quiet', warnings: [], signatures: [] }
    }} />);

    expect(html).toContain('<dt>Informe generado el</dt>');
    expect(html).not.toContain('Periodo revisado');
  });

  test.each([
    { locale: 'en' as const, skipped: 'Not sent (skipped or not configured)', pending: 'Pending confirmation' },
    { locale: 'es' as const, skipped: 'No enviada (omitida o no configurada)', pending: 'Pendiente de confirmación' }
  ])('uses honest $locale delivery labels', ({ locale, skipped, pending }) => {
    setLocale(locale);
    const report = (deliveryStatus: 'pending' | 'skipped') => renderToStaticMarkup(<ReportDetail report={{
      id: `delivery-${deliveryStatus}`,
      summary: { id: `delivery-${deliveryStatus}`, window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus },
      rendered: { format: 'markdown', body: '# Report' }
    }} />);

    expect(report('skipped')).toContain(skipped);
    expect(report('pending')).toContain(pending);
  });

  test('renders the versioned presentation in a clear, severity-led hierarchy', () => {
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'report-structured',
      summary: { id: 'report-structured', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 1, warning: 0, info: 1 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'sent' },
      rendered: { format: 'markdown', body: '# Home Assistant Digest' },
      presentation: {
        version: 1,
        mode: 'structured',
        overview: { title: 'Home Assistant Digest', detail: 'One urgent condition needs review.' },
        attention: [{ id: 'attention-1', severity: 'critical', title: 'Garage door sensor', detail: 'Unavailable for 3 hours.' }],
        observations: [{ id: 'observations-1', severity: 'info', title: 'Hallway temperature', detail: 'Changed more often than usual.' }],
        allGood: [],
        recommendations: [{ id: 'recommendation-1', severity: 'critical', title: 'Garage door sensor', detail: 'Unavailable for 3 hours.' }],
        evidence: [{ id: 'evidence-1', title: 'Recorder window', detail: 'No gaps were reported.' }]
      }
    }} />);

    expect(html).toContain('Resumen');
    expect(html).toContain('Requiere atención');
    expect(html).toContain('Crítica');
    expect(html).toContain('Observaciones');
    expect(html).toContain('Recomendación');
    expect(html).toContain('Evidencia');
    expect(html).toContain('Garage door sensor');
    expect(html).not.toContain('<pre>');
  });

  test('labels reports without a presentation as legacy while preserving safe readable content', () => {
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'report-unstructured',
      summary: { id: 'report-unstructured', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'pending' },
      rendered: { format: 'markdown', body: '# Importado\n\n<script>no ejecutar</script>' },
      presentation: { version: 1, mode: 'legacy_markdown', legacyMarkdown: '# Importado\n\n<script>no ejecutar</script>' }
    }} />);

    expect(html).toContain('Informe importado (formato anterior)');
    expect(html).toContain('&lt;script&gt;no ejecutar&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  test('redacts credential-shaped values from legacy detail at the UI boundary', () => {
    const rawSecrets = ['ui-bearer-fixture', 'ui-token-fixture', 'ui-api-key-fixture', 'ui-access-token-fixture', 'ui-password-fixture', 'ui-secret-fixture', 'ui-query-token-fixture'];
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'report-unsafe-legacy',
      summary: { id: 'report-unsafe-legacy', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'skipped' },
      rendered: { format: 'markdown', body: '# Legacy report' },
       presentation: { version: 1, mode: 'legacy_markdown', legacyMarkdown: `# Legacy report\n\nModel retired; Bearer ${rawSecrets[0]} token=${rawSecrets[1]} api-key: ${rawSecrets[2]} access_token=${rawSecrets[3]} password=${rawSecrets[4]} secret: ${rawSecrets[5]} https://provider.test/run?token=${rawSecrets[6]}` }
    }} />);

    expect(html).toContain('Model retired');
    for (const secret of rawSecrets) expect(html).not.toContain(secret);
    expect(html).not.toContain('<script>');
  });

  test('uses localized all-good copy for an empty structured report', () => {
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'report-empty',
      summary: { id: 'report-empty', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'sent' },
      rendered: { format: 'markdown', body: '# Home Assistant Digest' },
      presentation: {
        version: 1,
        mode: 'structured',
        overview: { title: 'Home Assistant Digest', detail: 'No actionable incidents were found.' },
        attention: [], observations: [],
        allGood: [{ id: 'all-good-1', title: 'No actionable incidents', detail: 'No critical or warning incidents were recorded for this report.' }],
        recommendations: [], evidence: []
      }
    }} />);

    expect(html).toContain('Todo correcto');
    expect(html).toContain('Sin incidencias que requieran atención.');
    expect(html).not.toContain('No critical or warning incidents were recorded for this report.');
  });

  test('renders v2 signature classes, integration degradation, warnings, and full recommendations', () => {
    setLocale('en');
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'v2-report-1', summary: { id: 'v2-report-1', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 1, warning: 0, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'skipped', runStatus: 'partial', warningCodes: ['AI_ANALYSIS_PARTIAL'], signatureCounts: { new: 1, recurring: 0, reactivated: 0, latent: 0 } }, rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'partial', warnings: ['AI_ANALYSIS_PARTIAL'], integrationStatus: { available: false }, signatures: [{ signature: 'sig-1', component: 'automation.garage', level: 'CRITICAL', classification: 'reactivated', trend: 'increasing', occurrences: 3, analysis: { summary: 'Garage automation has failed repeatedly.', recommendation: 'Inspect its recent traces before retrying it.' } }] }
    }} />);
    expect(html).toContain('Analysis information');
    expect(html).toContain('AI could not explain every detected problem.');
    expect(html).toContain('Integration status is unavailable.');
    expect(html).toContain('Reactivated');
    expect(html).toContain('Garage automation has failed repeatedly.');
    expect(html).toContain('Inspect its recent traces before retrying it.');
  });

  test('explains the real partial-report shape as three separate outcomes in plain Spanish', () => {
    setLocale('es');
    const signatures = Array.from({ length: 38 }, (_, index) => ({
      signature: `technical-signature-${index + 1}`,
      component: `homeassistant.component_${index + 1}`,
      level: index === 0 ? 'CRITICAL' as const : 'ERROR' as const,
      classification: index === 0 ? 'reactivated' as const : 'new' as const,
      trend: index === 0 ? 'increasing' as const : 'new' as const,
      occurrences: index + 1,
      ...(index < 7 ? { analysis: { summary: `Explicación ${index + 1}`, recommendation: `Recomendación ${index + 1}` } } : {})
    }));
    const id = 'v2-report:480e2f6c-c57a-498c-883a-d49f604e8b9b';
    const html = renderToStaticMarkup(<ReportDetail report={{
      id,
      source: 'v2',
      summary: { id, window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 1, warning: 37, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'failed', source: 'v2', runStatus: 'partial', warningCodes: ['AI_ANALYSIS_PARTIAL'], signatureCounts: { new: 37, recurring: 0, reactivated: 1, latent: 0 } },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'partial', warnings: ['AI_ANALYSIS_PARTIAL'], signatures }
    }} />);

    expect(html).toContain('<h1>Detalle del informe</h1>');
    expect(html).toContain(`translate="no" dir="ltr">${id}`);
    expect(html).toContain('Resultado del informe');
    expect(html).toContain('Generado con análisis de IA incompleto');
    expect(html).toContain('Análisis de IA');
    expect(html).toContain('7 de 38 problemas detectados explicados por la IA');
    expect(html).toContain('31 problemas no pudieron explicarse');
    expect(html).toContain('Notificación de Telegram');
    expect(html).toContain('El informe existe, pero no se pudo enviar la notificación. El motivo exacto no quedó registrado.');
    expect(html).toContain('Revisa la configuración de Telegram y envía una prueba desde Configuración.');
    expect(html).toContain('Problemas detectados');
    expect(html).toContain('Los mensajes repetidos del mismo problema se agrupan para que el informe sea más fácil de leer.');
    expect(html).toContain('Explicación de la IA');
    expect(html).toContain('Recomendación de la IA');
    expect(html).not.toContain('Tendencia:');
    expect(html).toContain('3 apariciones');
    expect(html).not.toContain('Análisis de firmas');
    expect(html).not.toContain('Tendencia: increasing');
    expect(html).not.toContain('AI_ANALYSIS_PARTIAL</p>');
    expect(html.indexOf('homeassistant.component_1')).toBeGreaterThan(html.indexOf('Problema reactivado'));
  });

  test.each([
    { code: 'TELEGRAM_HTTP_401' as const, copy: 'Telegram rechazó las credenciales configuradas.', action: 'Revisa el token del bot en Configuración y envía una prueba.' },
    { code: 'TELEGRAM_HTTP_429' as const, copy: 'Telegram limitó temporalmente los envíos.', action: 'Espera unos minutos y vuelve a intentarlo.' }
  ])('explains safe Telegram diagnostic $code without exposing technical data', ({ code, copy, action }) => {
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'delivery-safe-diagnostic',
      source: 'v2',
      summary: {
        id: 'delivery-safe-diagnostic', window: { from: '2026-08-13T09:00:00.000Z', to: '2026-08-13T10:00:00.000Z' },
        severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-13T10:00:00.000Z', deliveryStatus: 'failed', source: 'v2', runStatus: 'reported',
        deliveryDiagnostic: { channel: 'telegram', stage: 'response', errorCode: code, messageKey: code === 'TELEGRAM_HTTP_401' ? 'telegram_auth_failed' : 'telegram_rate_limited', recordedAt: '2026-08-13T10:00:01.000Z' }
      },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'reported', warnings: [], signatures: [] }
    }} />);

    expect(html).toContain(copy);
    expect(html).toContain(action.replace('&', '&amp;'));
    expect(html).not.toContain(code);
  });

  test('explains an indeterminate Telegram response without calling it rejected', () => {
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'delivery-invalid-response', source: 'v2',
      summary: {
        id: 'delivery-invalid-response', window: { from: '2026-08-13T09:00:00.000Z', to: '2026-08-13T10:00:00.000Z' },
        severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-13T10:00:00.000Z', deliveryStatus: 'pending', source: 'v2', runStatus: 'reported',
        deliveryDiagnostic: { channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_INVALID_RESPONSE', messageKey: 'telegram_invalid_response', recordedAt: '2026-08-13T10:00:01.000Z' }
      },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'reported', warnings: [], signatures: [] }
    }} />);

    expect(html).toContain('Pendiente de confirmación');
    expect(html).toContain('No se pudo confirmar la respuesta de Telegram.');
    expect(html).toContain('Comprueba el chat antes de intentar un nuevo envío para evitar duplicados.');
    expect(html).not.toContain('Telegram rechazó');
    expect(html).not.toContain('TELEGRAM_INVALID_RESPONSE');
  });

  test('describes repeated Plex DNS resolution evidence without claiming transience or recovery', () => {
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'plex-resolution', summary: { id: 'plex-resolution', window: { from: '2026-08-13T09:00:00.000Z', to: '2026-08-13T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-13T10:00:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'reported' }, rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'reported', warnings: [], integrationStatus: { available: true, total: 1, loaded: 1, notLoaded: 0, inProgress: 0, retrying: 0, errors: 0, unknown: 0 }, signatures: [{ signature: 'plex-dns', component: 'homeassistant.components.plex', level: 'ERROR', classification: 'recurring', trend: 'unknown', occurrences: 3, problemKind: 'endpoint_resolution', analysis: { summary: 'raw model outage claim', recommendation: 'raw model action' } }] }
    }} />);

    expect(html).toContain('Home Assistant no pudo resolver el punto de conexión de Plex en los eventos registrados.');
    expect(html).toContain('Problema de resolución del punto de conexión');
    expect(html).toContain('3 apariciones');
    expect(html).not.toContain('raw model outage claim');
    expect(html).not.toContain('transitorio');
    expect(html).not.toContain('temporalmente');
    expect(html).not.toContain('sigue disponible');
    expect(html).not.toContain('no hace falta actuar');
    expect(html).not.toContain('Tendencia:');
  });

  test('uses honest localized outcome copy when no report was generated', () => {
    setLocale('en');
    const html = renderToStaticMarkup(<ReportDetail onManualTelegramSend={async () => undefined} report={{
      id: 'v2-run:failed-report',
      source: 'v2',
      summary: { id: 'v2-run:failed-report', window: { from: '2026-08-01T09:59:59.999Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'failed', warningCodes: ['AI_ANALYSIS_UNAVAILABLE'] },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'failed', warnings: ['AI_ANALYSIS_UNAVAILABLE'], signatures: [], failure: 'The AI analysis was unavailable.' },
      manualTelegram: { configured: true, attempts: [] }
    }} />);

    expect(html).toContain('Report not generated');
    expect(html).toContain('AI analysis unavailable');
    expect(html).toContain('Not sent (skipped or not configured)');
    expect(html).not.toContain('Send again via Telegram');
  });

  test.each([
    { locale: 'en' as const, expected: 'AI could not produce a usable explanation for some of the detected problems.' },
    { locale: 'es' as const, expected: 'La IA no pudo generar una explicación útil para algunos de los problemas detectados.' }
  ])('maps malformed provider analysis to plain $locale failure copy', ({ locale, expected }) => {
    setLocale(locale);
    const internalFailure = 'OpenAI provider returned an invalid signature analysis';
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: `v2-invalid-analysis-${locale}`,
      source: 'v2',
      summary: { id: `v2-invalid-analysis-${locale}`, window: { from: '2026-08-01T09:59:59.999Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'failed', warningCodes: ['AI_ANALYSIS_UNAVAILABLE'] },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'failed', warnings: ['AI_ANALYSIS_UNAVAILABLE'], signatures: [], failure: internalFailure }
    }} />);

    expect(html).toContain(expected);
    expect(html).not.toContain(internalFailure);
    expect(html.toLowerCase()).not.toContain('signature');
    expect(html.toLowerCase()).not.toContain('firma');
  });

  test('renders persisted operator notes with their matching later v2 signature', () => {
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'v2-report-with-note', summary: { id: 'v2-report-with-note', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'skipped', runStatus: 'reported', warningCodes: [], signatureCounts: { new: 1, recurring: 0, reactivated: 0, latent: 0 } }, rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'reported', warnings: [], signatures: [{ signature: 'sig-noted', component: 'zwave', level: 'ERROR', classification: 'new', trend: 'new', occurrences: 1, notes: [{ id: 'note-1', text: 'Operator already checked this device.', occurredAt: '2026-08-01T09:30:00.000Z', createdAt: '2026-08-01T09:30:00.000Z', tags: ['sig-noted'] }] }] }
    }} />);

    expect(html).toContain('Operator already checked this device.');
  });

  test('renders sparse integration fields without undefined placeholders', () => {
    setLocale('en');
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'v2-sparse-integration',
      summary: { id: 'v2-sparse-integration', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'pending' },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'reported', warnings: [], integrationStatus: { available: true, total: 1, loaded: 0, notLoaded: 0, inProgress: 0, retrying: 0, errors: 0, unknown: 1 }, signatures: [] }
    }} />);

    expect(html).toContain('No integration states requiring action were detected.');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('(undefined)');
  });

  test('renders compact aggregate integration status without exposing legacy private identifiers', () => {
    const sentinels = ['owner@example.test', '192.0.2.10', 'https://private.example.test/account', 'Bedroom private device', 'private_service_domain'];
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'v2-private-integrations',
      source: 'v2',
      summary: { id: 'v2-private-integrations', window: { from: '2026-08-13T20:15:00.000Z', to: '2026-08-13T21:15:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-13T21:15:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'quiet' },
      rendered: { format: 'markdown', body: '' },
      presentation: {
        version: 2,
        mode: 'batch',
        status: 'quiet',
        warnings: [],
        integrationStatus: {
          available: true,
          integrations: [
            { domain: sentinels[4], title: sentinels[0], state: 'loaded' },
            { domain: 'private_ip', title: sentinels[1], state: 'not_loaded' },
            { domain: 'private_setup', title: 'Private setup', state: 'setup_in_progress' },
            { domain: 'private_unload', title: 'Private unload', state: 'unload_in_progress' },
            { domain: 'private_retry', title: 'Private retry', state: 'setup_retry' },
            { domain: 'private_url', title: sentinels[2], state: 'setup_error', reason: 'invalid_auth' },
            { domain: 'private_migration', title: 'Private migration', state: 'migration_error' },
            { domain: 'private_device', title: sentinels[3], state: 'failed_unload' },
            { domain: 'private_future', title: 'Private future', state: 'future_state' },
            { domain: 'private_malformed', title: 'Private malformed' }
          ]
        },
        signatures: []
      } as never
    }} />);

    expect(html).toContain('<dt>Comprobadas</dt><dd>10</dd>');
    expect(html).toContain('<dt>Activas</dt><dd>1</dd>');
    expect(html).toContain('<dt>No cargadas</dt><dd>1</dd>');
    expect(html).toContain('<dt>En proceso</dt><dd>2</dd>');
    expect(html).toContain('<dt>Reintentando</dt><dd>1</dd>');
    expect(html).toContain('<dt>Con errores</dt><dd>3</dd>');
    expect(html).toContain('<dt>Estado desconocido</dt><dd>2</dd>');
    expect(html).toContain('Solo las integraciones con errores requieren actuar ahora.');
    expect(html).toContain('Home Assistant volverá a intentar automáticamente');
    expect(html).toContain('No cargada puede ser normal');
    for (const sentinel of sentinels) expect(html).not.toContain(sentinel);
  });

  test('keeps not-loaded integrations neutral when no attention state exists', () => {
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'v2-neutral-integrations', source: 'v2',
      summary: { id: 'v2-neutral-integrations', window: { from: '2026-08-13T20:15:00.000Z', to: '2026-08-13T21:15:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-13T21:15:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'quiet' },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'quiet', warnings: [], integrationStatus: { available: true, total: 4, loaded: 1, notLoaded: 1, inProgress: 1, retrying: 1, errors: 0, unknown: 0 }, signatures: [] }
    }} />);

    expect(html).toContain('No se detectaron estados de integración que requieran actuar.');
    expect(html).toContain('En proceso');
    expect(html).toContain('Reintentando');
    expect(html).not.toContain('requieren actuar ahora');
  });

  test('explains a safe integration snapshot reason without exposing connection details', () => {
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'ha-timeout', summary: { id: 'ha-timeout', window: { from: '2026-08-13T09:00:00.000Z', to: '2026-08-13T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-13T10:00:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'quiet' }, rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'quiet', warnings: [], integrationStatus: { available: false, reason: 'socket_timeout' }, signatures: [] }
    }} />);

    expect(html).toContain('Home Assistant no respondió a tiempo al consultar las integraciones.');
    expect(html).toContain('Comprueba que Home Assistant esté accesible y vuelve a generar el informe.');
    expect(html).not.toContain('socket_timeout');
  });

  test.each([
    { locale: 'en' as const, category: 'Authentication error', reason: 'Authentication failed', action: 'Home Assistant → Settings → Devices & services' },
    { locale: 'es' as const, category: 'Error de autenticación', reason: 'Autenticación fallida', action: 'Home Assistant → Configuración → Dispositivos y servicios' }
  ])('shows only privacy-safe actionable integration groups in $locale', ({ locale, category, reason, action }) => {
    setLocale(locale);
    const sentinels = ['owner@example.test', '192.0.2.10', 'https://private.example.test', 'Bedroom private device', 'entry-private-id', 'arbitrary private reason'];
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'safe-integration-groups', source: 'v2',
      summary: { id: 'safe-integration-groups', window: { from: '2026-08-14T11:00:00.000Z', to: '2026-08-14T12:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-14T12:00:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'quiet' },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'quiet', warnings: [], integrationStatus: { available: true, total: 8, loaded: 2, notLoaded: 1, inProgress: 1, retrying: 1, errors: 2, unknown: 1, errorGroups: [
        { category: 'authentication_error', reason: 'authentication_failed', count: 1 },
        { category: 'setup_error', reason: 'unknown', count: 1 }
      ] }, signatures: [] }
    }} />);

    expect(html).toContain(category);
    expect(html).toContain(reason);
    expect(html).toContain(action.replace('&', '&amp;'));
    expect(html).toContain(locale === 'en' ? '<dt>Active</dt><dd>2</dd>' : '<dt>Activas</dt><dd>2</dd>');
    for (const sentinel of sentinels) expect(html).not.toContain(sentinel);
  });

  test.each([
    { locale: 'en' as const, expected: 'Error categories were not retained for this older report.' },
    { locale: 'es' as const, expected: 'Las categorías de error no se conservaron en este informe anterior.' }
  ])('explains missing historical integration groups in $locale', ({ locale, expected }) => {
    setLocale(locale);
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'old-integration-errors', source: 'v2',
      summary: { id: 'old-integration-errors', window: { from: '2026-08-14T11:00:00.000Z', to: '2026-08-14T12:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-14T12:00:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'quiet' },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'quiet', warnings: [], integrationStatus: { available: true, total: 1, loaded: 0, notLoaded: 0, inProgress: 0, retrying: 0, errors: 1, unknown: 0 }, signatures: [] }
    }} />);

    expect(html).toContain(expected);
  });

  test('renders only a collapsed redacted trace for an AI-unexplained problem', () => {
    setLocale('en');
    const sentinels = ['owner@example.test', '192.0.2.10', 'private-token', 'sensor.private_room'];
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'safe-trace-report', source: 'v2',
      summary: { id: 'safe-trace-report', window: { from: '2026-08-14T11:00:00.000Z', to: '2026-08-14T12:00:00.000Z' }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-14T12:00:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'partial' },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'partial', warnings: ['AI_ANALYSIS_UNAVAILABLE'], signatures: [{
        signature: 'safe-trace-signature', component: 'custom_components.hidden', level: 'ERROR', classification: 'new', trend: 'new', occurrences: 1,
        safeExcerpt: { lines: ['Traceback (redacted)', 'File "custom_components/[hidden]/coordinator.py", line 42, in async_refresh', 'ConnectionError'], truncated: true, redacted: true }
      }] }
    }} />);

    expect(html).toContain('<details class="report-trace-detail">');
    expect(html).not.toContain('<details class="report-trace-detail" open');
    expect(html).toContain('View redacted error trace');
    expect(html).toContain('Secrets and private values are hidden, and this excerpt is shortened.');
    expect(html).toContain('<pre><code dir="ltr" translate="no">Traceback (redacted)');
    expect(html).toContain('custom_components/[hidden]/coordinator.py');
    for (const sentinel of sentinels) expect(html).not.toContain(sentinel);
    expect(html.toLowerCase()).not.toContain('raw trace');
    expect(html.toLowerCase()).not.toContain('complete trace');
  });

  test('states that redacted trace evidence is unavailable for an old unexplained report', () => {
    setLocale('en');
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'old-no-trace', source: 'v2',
      summary: { id: 'old-no-trace', window: { from: '2026-08-14T11:00:00.000Z', to: '2026-08-14T12:00:00.000Z' }, severityCounts: { critical: 0, warning: 1, info: 0 }, createdAt: '2026-08-14T12:00:00.000Z', deliveryStatus: 'skipped', source: 'v2', runStatus: 'partial' },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'partial', warnings: ['AI_ANALYSIS_PARTIAL'], signatures: [{ signature: 'old-signature', component: 'mqtt', level: 'ERROR', classification: 'new', trend: 'new', occurrences: 1 }] }
    }} />);

    expect(html).toContain('A privacy-safe trace excerpt is unavailable for this problem.');
    expect(html).not.toContain('<pre>');
  });
});
