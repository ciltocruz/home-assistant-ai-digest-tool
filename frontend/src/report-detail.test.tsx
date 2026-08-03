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

    expect(html).toContain('Informe #report-9');
    expect(html).toContain('Una incidencia crítica.');
    expect(html).toContain('Resumen de severidad');
    expect(html).toContain('Críticas 1');
    expect(html).toContain('Avisos 0');
    expect(html).toContain('Observaciones 2');
    expect(html).toContain('Volver a informes');
    expect(html).not.toContain('<pre>');
  });

  test('keeps legacy Markdown readable without interpreting it as HTML', () => {
    const html = renderToStaticMarkup(<ReportDetail report={{
      id: 'report-legacy',
      summary: { id: 'report-legacy', window: { from: '2026-08-01T09:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, severityCounts: { critical: 0, warning: 0, info: 0 }, createdAt: '2026-08-01T10:00:00.000Z', deliveryStatus: 'skipped' },
      rendered: { format: 'markdown', body: '# Informe heredado\n\n- Sensor estable\n- <script>no ejecutar</script>' }
    }} />);

    expect(html).toContain('<h2>Informe heredado</h2>');
    expect(html).toContain('<li>Sensor estable</li>');
    expect(html).toContain('&lt;script&gt;no ejecutar&lt;/script&gt;');
    expect(html).toContain('Formato heredado');
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

    expect(html).toContain('Formato heredado');
    expect(html).toContain('&lt;script&gt;no ejecutar&lt;/script&gt;');
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
      presentation: { version: 2, mode: 'batch', status: 'partial', warnings: ['AI_ANALYSIS_PARTIAL'], integrationStatus: { available: false, integrations: [] }, signatures: [{ signature: 'sig-1', component: 'automation.garage', level: 'CRITICAL', classification: 'reactivated', trend: 'increasing', occurrences: 3, analysis: { summary: 'Garage automation has failed repeatedly.', recommendation: 'Inspect its recent traces before retrying it.' } }] }
    }} />);
    expect(html).toContain('Analysis warnings');
    expect(html).toContain('Integration status is unavailable.');
    expect(html).toContain('Reactivated');
    expect(html).toContain('Garage automation has failed repeatedly.');
    expect(html).toContain('Inspect its recent traces before retrying it.');
  });
});
