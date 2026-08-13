import { describe, expect, it } from 'vitest';
import { DigestDetailSchema } from '@ha-digest/shared';
import { projectLegacyReportPresentation, projectReportPresentation, redactReportDetail } from './report-presentation.js';

const summary = {
  id: 'digest-structured',
  window: { from: '2026-08-01T08:00:00.000Z', to: '2026-08-01T09:00:00.000Z' },
  severityCounts: { critical: 1, warning: 1, info: 1 },
  createdAt: '2026-08-01T09:00:00.000Z',
  deliveryStatus: 'sent' as const
};

describe('projectReportPresentation', () => {
  it('projects complete canonical report content into truthful, stable sections', () => {
    const presentation = projectReportPresentation({
      id: summary.id,
      summary,
      rendered: {
        format: 'markdown',
        body: `# Home Assistant Digest

**Severity:** critical

Two conditions need review before the next scheduled run.

## Attention items

- **Garage door sensor** (critical): The sensor has been unavailable for 3 hours.
- **Living room battery** (warning): Battery level is below 15%.

## Observations

- **Hallway temperature** (info): The temperature changed more often than usual.

## Evidence

- **Recorder window**: No gaps were reported during this window.`
      }
    });

    expect(presentation).toEqual({
      version: 1,
      mode: 'structured',
      overview: { title: 'Home Assistant Digest', detail: 'Two conditions need review before the next scheduled run.' },
      attention: [
        { id: 'attention-1', severity: 'critical', title: 'Garage door sensor', detail: 'The sensor has been unavailable for 3 hours.' },
        { id: 'attention-2', severity: 'warning', title: 'Living room battery', detail: 'Battery level is below 15%.' }
      ],
      observations: [
        { id: 'observations-1', severity: 'info', title: 'Hallway temperature', detail: 'The temperature changed more often than usual.' }
      ],
      allGood: [],
      recommendations: [
        { id: 'recommendation-1', severity: 'critical', title: 'Garage door sensor', detail: 'The sensor has been unavailable for 3 hours.' }
      ],
      evidence: [
        { id: 'evidence-1', title: 'Recorder window', detail: 'No gaps were reported during this window.' }
      ]
    });
  });

  it('projects a canonical empty report as all-good only when the stored counts have no actionable incident', () => {
    const presentation = projectReportPresentation({
      id: 'digest-empty',
      summary: { ...summary, id: 'digest-empty', severityCounts: { critical: 0, warning: 0, info: 0 } },
      rendered: { format: 'markdown', body: '# Home Assistant Digest\n\n**Severity:** clear\n\nNo actionable incidents were found.' }
    });

    expect(presentation.mode).toBe('structured');
    if (presentation.mode !== 'structured') throw new Error('Expected a structured presentation');
    expect(presentation.allGood).toEqual([{ id: 'all-good-1', title: 'No actionable incidents', detail: 'No critical or warning incidents were recorded for this report.' }]);
    expect(presentation.attention).toEqual([]);
    expect(presentation.recommendations).toEqual([]);
  });

  it('keeps a legacy report unchanged when it lacks the canonical structured fields', () => {
    const body = '# Imported report\n\nA legacy integration supplied this Markdown.';
    const presentation = projectReportPresentation({ id: 'digest-legacy', summary: { ...summary, id: 'digest-legacy' }, rendered: { format: 'markdown', body } });

    expect(presentation).toEqual({ version: 1, mode: 'legacy_markdown', legacyMarkdown: body });
  });

  it('keeps malformed canonical-looking Markdown in the legacy fallback instead of guessing its sections', () => {
    const body = '# Home Assistant Digest\n\n**Severity:** warning\n\n## Attention items\n\n- Missing severity and explanation';
    const presentation = projectReportPresentation({ id: 'digest-malformed', summary: { ...summary, id: 'digest-malformed' }, rendered: { format: 'markdown', body } });

    expect(presentation).toEqual({ version: 1, mode: 'legacy_markdown', legacyMarkdown: body });
  });

  it('projects a canonical-looking legacy report as legacy when its source is explicit', () => {
    const body = `# Home Assistant Digest

**Severity:** warning

One condition needs review.

## Attention items

- **Provider failure** (warning): Bearer legacy-canonical-bearer token=legacy-canonical-token`;

    const presentation = projectLegacyReportPresentation({ id: 'legacy-canonical', summary, rendered: { format: 'markdown', body } });
    expect(presentation).toEqual({
      version: 1,
      mode: 'legacy_markdown',
      legacyMarkdown: expect.stringContaining('[REDACTED]')
    });
    if (presentation.mode !== 'legacy_markdown') throw new Error('Expected a legacy Markdown presentation');
    expect(presentation.legacyMarkdown).not.toContain('legacy-canonical-bearer');
  });

  it('redacts legacy content at the presentation boundary before it can be rendered', () => {
    const rawSecrets = ['detail-bearer', 'detail-token', 'detail-api-key', 'detail-query-token'];
    const report = redactReportDetail({
      id: 'legacy-boundary',
      summary,
      rendered: { format: 'markdown', body: '# Legacy' },
      presentation: projectLegacyReportPresentation({
        id: 'legacy-boundary',
        summary,
        rendered: { format: 'markdown', body: `Bearer ${rawSecrets[0]} token=${rawSecrets[1]} api_key=${rawSecrets[2]} https://provider.test/?token=${rawSecrets[3]}` }
      })
    });

    for (const secret of rawSecrets) expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('redacts v2 signature analyses at the API/UI projection boundary', () => {
    const rawSecrets = [
      'http-bearer-fixture',
      'http-token-fixture',
      'http-api-key-fixture',
      'http-query-token-fixture',
      '123456:ABCdefGHIjklMNOpqr',
      '987654:ZYXwvUTSrqponMLK'
    ];
    const report = redactReportDetail({
      id: 'v2-boundary',
      source: 'v2',
      summary,
      rendered: { format: 'markdown', body: '' },
      presentation: {
        version: 2,
        mode: 'batch',
        status: 'reported',
        warnings: [],
        signatures: [{
          signature: 'sig-1',
          component: 'mqtt',
          level: 'ERROR',
          classification: 'new',
          trend: 'new',
          occurrences: 1,
          analysis: {
            summary: `Incident: Bearer ${rawSecrets[0]} token=${rawSecrets[1]} api_key=${rawSecrets[2]} https://provider.test/?token=${rawSecrets[3]} botToken=${rawSecrets[4]}. Token budget is stable.`,
            recommendation: `Restart after bot_token: ${rawSecrets[5]}; keep API key rotation documented.`
          }
        }]
      }
    });

    for (const secret of rawSecrets) expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).toContain('Token budget is stable');
    expect(JSON.stringify(report)).toContain('API key rotation documented');
  });

  it('sanitizes batch warnings and aggregates legacy integration status arriving from another store seam', () => {
    const rawSecrets = ['seam-warning-token-fixture', 'seam-integration-secret-fixture'];
    const privateIntegrationValues = ['owner@example.test', '192.0.2.10', 'https://private.example.test/account', 'Bedroom private device', 'private_service_domain'];
    const report = redactReportDetail({
      id: 'v2-seam-boundary',
      source: 'v2',
      summary,
      rendered: { format: 'markdown', body: '' },
      presentation: {
        version: 2,
        mode: 'batch',
        status: 'reported',
        warnings: [`Bearer ${rawSecrets[0]}`],
        integrationStatus: {
          available: true,
          providerControlled: rawSecrets[1],
          integrations: [
            { domain: privateIntegrationValues[4], title: privateIntegrationValues[0], state: 'loaded' },
            { domain: 'private_ip', title: privateIntegrationValues[1], state: 'not_loaded' },
            { domain: 'private_setup', title: 'Private setup', state: 'setup_in_progress' },
            { domain: 'private_unload', title: 'Private unload', state: 'unload_in_progress' },
            { domain: 'private_retry', title: 'Private retry', state: 'setup_retry' },
            { domain: 'private_url', title: privateIntegrationValues[2], state: 'setup_error', reason: 'invalid_auth' },
            { domain: 'private_migration', title: 'Private migration', state: 'migration_error' },
            { domain: 'private_device', title: privateIntegrationValues[3], state: 'failed_unload' },
            { domain: 'private_future', title: `MQTT Bearer ${rawSecrets[0]}`, state: `token=${rawSecrets[1]}`, opaque: 'do-not-return' },
            { domain: 'private_malformed', title: 'Private malformed' }
          ]
        },
        signatures: []
      } as never
    });

    expect(report.presentation).toEqual(expect.objectContaining({
      warnings: ['Bearer [REDACTED]'],
      integrationStatus: {
        available: true,
        total: 10,
        loaded: 1,
        notLoaded: 1,
        inProgress: 2,
        retrying: 1,
        errors: 3,
        unknown: 2
      }
    }));
    const serialized = JSON.stringify(report);
    for (const secret of rawSecrets) expect(serialized).not.toContain(secret);
    for (const value of privateIntegrationValues) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('providerControlled');
    expect(serialized).not.toContain('opaque');
  });

  it('redacts warning codes in the batch summary projection', () => {
    const report = redactReportDetail({
      id: 'v2-summary-warning-boundary',
      source: 'v2',
      summary: { ...summary, warningCodes: ['Bearer summary-warning-secret'] },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'partial', warnings: [], signatures: [] }
    });

    expect(report.summary.warningCodes).toEqual(['Bearer [REDACTED]']);
    expect(JSON.stringify(report)).not.toContain('summary-warning-secret');
  });

  it('projects only the bounded indeterminate Telegram diagnostic fields', () => {
    const report = redactReportDetail({
      id: 'v2-invalid-telegram-response', source: 'v2',
      summary: {
        ...summary, deliveryStatus: 'pending',
        deliveryDiagnostic: {
          channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_INVALID_RESPONSE',
          messageKey: 'telegram_invalid_response', recordedAt: '2026-08-13T10:00:01.000Z', rawBody: 'private response body'
        }
      } as never,
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'reported', warnings: [], signatures: [] }
    });

    expect(report.summary.deliveryDiagnostic).toEqual({
      channel: 'telegram', stage: 'response', errorCode: 'TELEGRAM_INVALID_RESPONSE',
      messageKey: 'telegram_invalid_response', recordedAt: '2026-08-13T10:00:01.000Z'
    });
    expect(JSON.stringify(report)).not.toContain('private response body');
  });

  it('normalizes malformed summary counts before returning a schema-valid detail', () => {
    const report = redactReportDetail({
      id: 'malformed-counts',
      summary: { ...summary, severityCounts: { critical: -1, warning: 1.5, info: 'unknown' as never }, signatureCounts: { new: -1, recurring: 1.5, reactivated: 'unknown' as never, latent: 2 } },
      rendered: { format: 'markdown', body: '' },
      presentation: { version: 2, mode: 'batch', status: 'reported', warnings: [], signatures: [] }
    });

    expect(DigestDetailSchema.parse(report).summary).toMatchObject({
      severityCounts: { critical: 0, warning: 0, info: 0 },
      signatureCounts: { new: 0, recurring: 0, reactivated: 0, latent: 2 }
    });
  });
});
