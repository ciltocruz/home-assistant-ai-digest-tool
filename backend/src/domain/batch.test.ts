import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { classifySignatures, parseHomeAssistantLog } from './batch.js';

const fixture = new URL('../../../tests/fixtures/ha/batch-formats.log', import.meta.url);

describe('batch log domain', () => {
  it('parses real Home Assistant ERROR and CRITICAL formats into stable signatures', async () => {
    const entries = parseHomeAssistantLog((await readFile(fixture, 'utf8')).trim().split('\n'));

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.level)).toEqual(['ERROR', 'CRITICAL', 'ERROR']);
    expect(entries[0]).toMatchObject({ component: 'homeassistant.components.recorder', normalizedMessage: 'database write failed for id=<number>' });
    expect(entries[0]?.signature).toBe(entries[2]?.signature);
  });

  it('keeps warnings opt-in and normalizes volatile values without retaining raw identifiers', () => {
    const line = '2026-07-29 12:00:00 WARNING (MainThread) [custom.integration] retry id=42 request=0xabcdef1234';
    expect(parseHomeAssistantLog([line])).toEqual([]);
    expect(parseHomeAssistantLog([line], { includeWarnings: true })[0]).toMatchObject({ normalizedMessage: 'retry id=<number> request=<id>' });
  });

  it('learns old entries silently and neutralizes trends without an equivalent prior window', () => {
    const entries = parseHomeAssistantLog([
      '2026-07-01 12:00:00 ERROR (MainThread) [ha.old] old issue id=1',
      '2026-07-29 12:00:00 ERROR (MainThread) [ha.old] old issue id=2',
      '2026-07-29 12:01:00 ERROR (MainThread) [ha.new] new issue',
      '2026-07-29 12:02:00 ERROR (MainThread) [ha.recurring] recurring issue',
      '2026-07-29 12:03:00 ERROR (MainThread) [ha.reactivated] reactivated issue'
    ]);
    const byComponent = new Map(entries.map((entry) => [entry.component, entry]));
    const plan = classifySignatures(entries, [
      { signature: byComponent.get('ha.recurring')!.signature, firstSeenAt: '2026-07-25T00:00:00.000Z', lastSeenAt: '2026-07-28T00:00:00.000Z', previousPeriodCount: 1 },
      { signature: byComponent.get('ha.reactivated')!.signature, firstSeenAt: '2026-07-21T00:00:00.000Z', lastSeenAt: '2026-07-25T00:00:00.000Z', previousPeriodCount: 2 }
    ], { now: '2026-07-30T00:00:00.000Z', reactivationDays: 2 });

    expect(plan.baselineEntries).toHaveLength(1);
    expect(plan.signatures.map(({ component, classification, trend }) => ({ component, classification, trend }))).toEqual([
      { component: 'ha.old', classification: 'latent', trend: 'new' },
      { component: 'ha.new', classification: 'new', trend: 'new' },
      { component: 'ha.recurring', classification: 'recurring', trend: 'unknown' },
      { component: 'ha.reactivated', classification: 'reactivated', trend: 'unknown' }
    ]);
  });

  it('classifies DNS-resolution evidence only from Home Assistant Plex namespaces', () => {
    const [plexRoot, plexModule, unrelated, complex, simplex] = parseHomeAssistantLog([
      '2026-08-13 12:00:00 ERROR [homeassistant.components.plex] NameResolutionError: failed to resolve 192-0-2-1.example.plex.direct',
      '2026-08-13 12:01:00 ERROR [homeassistant.components.plex.media_player] NameResolutionError: failed to resolve 192-0-2-1.example.plex.direct',
      '2026-08-13 12:02:00 ERROR [homeassistant.components.plex] Authentication failed for Plex account',
      '2026-08-13 12:03:00 ERROR [homeassistant.components.complex] NameResolutionError: failed to resolve example.invalid',
      '2026-08-13 12:04:00 ERROR [custom_components.simplex] NameResolutionError: failed to resolve example.invalid'
    ]);

    expect(plexRoot?.problemKind).toBe('endpoint_resolution');
    expect(plexModule?.problemKind).toBe('endpoint_resolution');
    expect(unrelated?.problemKind).toBeUndefined();
    expect(complex?.problemKind).toBeUndefined();
    expect(simplex?.problemKind).toBeUndefined();
  });

  it('uses only the available current-file history when it cannot cover the full lookback window', () => {
    const entries = parseHomeAssistantLog([
      '2026-07-29 12:00:00 ERROR (MainThread) [ha.available] recent issue id=1',
      '2026-07-30 11:00:00 ERROR (MainThread) [ha.available] recent issue id=2'
    ]);

    const plan = classifySignatures(entries, [], { now: '2026-07-30T12:00:00.000Z', lookbackDays: 10 });

    expect(plan.baselineEntries).toEqual([]);
    expect(plan.signatures).toMatchObject([
      { component: 'ha.available', classification: 'new' }
    ]);
    expect(plan.signatures[0]?.occurrences).toHaveLength(2);
  });
});
