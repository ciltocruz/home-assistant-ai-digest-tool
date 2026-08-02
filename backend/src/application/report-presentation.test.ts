import { describe, expect, it } from 'vitest';
import { projectReportPresentation } from './report-presentation.js';

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
});
