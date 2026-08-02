import { describe, expect, it } from 'vitest';
import type { Incident } from '../domain/detectors.js';
import {
  applyIgnoreRules,
  buildRedactedDigestInput,
  predictBatteryIncidents,
  prioritizeIncidents,
  renderSafeMarkdown
} from './incident-processing.js';

const window = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z' };

describe('incident processing', () => {
  it('redacts secrets and bounds empty malicious provider input', () => {
    const input = buildRedactedDigestInput({
      window,
      privacyLevel: 'balanced',
      incidents: [incident('log', 'warning', 'Token abc123SECRETxyz failed for http://ha.local/api/webhook/123')],
      entityStats: {},
      notes: [{ id: 'n1', text: '<script>alert(1)</script> Bearer topsecret', occurredAt: window.from }],
      unsupportedSignals: [{ source: 'supervisor', reason: 'Supervisor API is unavailable in Docker/Core mode' }]
    });

    expect(JSON.stringify(input)).not.toContain('abc123SECRETxyz');
    expect(JSON.stringify(input)).not.toContain('topsecret');
    expect(input.incidents[0]?.redactedEvidence[0]).toContain('[REDACTED]');
    expect(input.notes[0]?.text).toContain('[REDACTED]');
    expect(input.redactionReport.length).toBeGreaterThan(0);
  });

  it('redacts structured entity stats before provider input', () => {
    const input = buildRedactedDigestInput({
      window,
      privacyLevel: 'balanced',
      incidents: [],
      entityStats: {
        unavailableCount: 2,
        rawEntity: {
          entityId: 'sensor.secret_sensor',
          attributes: {
            password: 'abc',
            api_key: 'short',
            token: 'Bearer super-token-value',
            friendlyName: 'Bedroom presence sensor'
          }
        },
        samples: ['password: tiny', 'api_key=value', 'Bearer other-secret']
      },
      notes: [],
      unsupportedSignals: []
    });

    const serialized = JSON.stringify(input.entityStats);
    expect(serialized).toContain('"unavailableCount":2');
    expect(serialized).not.toContain('abc');
    expect(serialized).not.toContain('short');
    expect(serialized).not.toContain('super-token-value');
    expect(serialized).not.toContain('Bedroom presence sensor');
    expect(serialized).not.toContain('api_key=value');
    expect(serialized).toContain('[REDACTED]');
  });

  it('handles empty incidents notes and history deterministically', () => {
    const input = buildRedactedDigestInput({
      window,
      privacyLevel: 'minimal',
      incidents: [],
      entityStats: {},
      notes: [],
      unsupportedSignals: []
    });

    expect(input.incidents).toEqual([]);
    expect(input.notes).toEqual([]);
    expect(input.entityStats).toEqual({});
    expect(input.redactionReport).toEqual([]);
    expect(predictBatteryIncidents([], {})).toEqual([]);
  });

  it('sanitizes unsafe markdown without allowing raw html or javascript links', async () => {
    const rendered = await renderSafeMarkdown({
      severity: 'critical',
      summary: '<img src=x onerror=alert(1)> [bad](javascript:alert(1))',
      attentionItems: [{ title: '<b>Battery</b>', severity: 'warning', detail: 'Use [docs](https://example.test/docs)' }]
    });

    expect(rendered.body).toContain('&lt;img');
    expect(rendered.body).not.toContain('javascript:');
    expect(rendered.body).toContain('[docs](https://example.test/docs)');
  });

  it('removes unsafe or malformed markdown links conservatively', async () => {
    const rendered = await renderSafeMarkdown({
      severity: 'warning',
      summary: '[relative](/local/path) [newline](https://example.test/ok\nnext) [bad](https://example.test/<script>)',
      attentionItems: [{ title: 'Docs', severity: 'info', detail: '[safe](https://example.test/docs?x=1#top)' }]
    });

    expect(rendered.body).not.toContain('[relative](');
    expect(rendered.body).not.toContain('/local/path');
    expect(rendered.body).not.toContain('https://example.test/ok\nnext');
    expect(rendered.body).not.toContain('<script>');
    expect(rendered.body).toContain('[safe](https://example.test/docs?x=1#top)');
  });

  it('suppresses active ignore matches and prioritizes remaining incidents', () => {
    const incidents = [
      incident('entity', 'warning', 'Kitchen sensor unavailable'),
      incident('log', 'critical', 'Recorder database failed'),
      incident('battery', 'info', 'Remote battery is low')
    ];

    const filtered = applyIgnoreRules(incidents, [
      { id: 'i1', match: 'kitchen sensor', type: 'entity', createdAt: window.from, reason: 'Known maintenance' }
    ], window.to);

    expect(filtered.map((item) => item.summary)).toEqual(['Recorder database failed', 'Remote battery is low']);
    expect(prioritizeIncidents(filtered).map((item) => item.severity)).toEqual(['critical', 'info']);
  });

  it('uses the incident ID as the final deterministic tie-breaker for equal priority', () => {
    const equalPriority = [
      { ...incident('log', 'warning', 'Z'), id: 'z-log' },
      { ...incident('log', 'warning', 'A'), id: 'a-log' }
    ];

    expect(prioritizeIncidents(equalPriority).map((item) => item.id)).toEqual(['a-log', 'z-log']);
  });

  it('applies area and message ignore rule semantics separately from incident type', () => {
    const incidents = [
      incident('entity', 'warning', 'Kitchen sensor unavailable', 'Kitchen'),
      incident('log', 'critical', 'Recorder database failed in storage'),
      incident('automation', 'warning', 'Morning routine skipped', 'Bedroom')
    ];

    const filtered = applyIgnoreRules(incidents, [
      { id: 'area-1', match: 'kitchen', type: 'area', createdAt: window.from },
      { id: 'message-1', match: 'recorder database', type: 'message', createdAt: window.from }
    ], window.to);

    expect(filtered.map((item) => item.summary)).toEqual(['Morning routine skipped']);
  });

  it('predicts battery attention with confidence based on history', () => {
    const incidents = predictBatteryIncidents(
      [
        { entityId: 'sensor.remote_battery', name: 'Remote', level: 12, observedAt: window.to },
        { entityId: 'sensor.motion_battery', name: 'Motion', level: 80, observedAt: window.to }
      ],
      { sensor_remote_battery: [{ at: '2026-06-25T00:00:00.000Z', level: 35 }] }
    );

    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.summary).toContain('Remote');
    expect(incidents[0]?.redactedEvidence.join('\n')).toContain('confidence=medium');
    expect(incidents[0]?.severity).toBe('warning');
  });
});

function incident(type: string, severity: Incident['severity'], summary: string, area?: string): Incident {
  return {
    id: `${type}-${severity}`,
    type,
    severity,
    area,
    summary,
    redactedEvidence: [summary],
    detectedAt: window.to
  };
}
