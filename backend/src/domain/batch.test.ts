import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildParsedEntry, chunkLogLinesForExtraction, classifySignatures, parseHomeAssistantLog } from './batch.js';

const fixture = new URL('../../../tests/fixtures/ha/batch-formats.log', import.meta.url);
const realWorldFixture = new URL('../../../tests/fixtures/ha/real-world-2026-09-06.log', import.meta.url);

describe('batch log domain', () => {
  it('parses real Home Assistant ERROR and CRITICAL formats into stable signatures', async () => {
    const entries = parseHomeAssistantLog((await readFile(fixture, 'utf8')).trim().split('\n'));

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.level)).toEqual(['ERROR', 'CRITICAL', 'ERROR']);
    expect(entries[0]).toMatchObject({ component: 'homeassistant.components.recorder', normalizedMessage: 'database write failed for id=<number>' });
    expect(entries[0]?.signature).toBe(entries[2]?.signature);
  });

  it('parses every timestamped line of a real production log including nested thread names', async () => {
    const lines = (await readFile(realWorldFixture, 'utf8')).trim().split('\n');
    const errors = parseHomeAssistantLog(lines);
    const everything = parseHomeAssistantLog(lines, { includeWarnings: true });

    expect(errors).toHaveLength(93);
    expect(everything).toHaveLength(168);
    const loaders = everything.filter((entry) => entry.component === 'homeassistant.loader');
    expect(loaders).toHaveLength(22);
    expect(loaders.some((entry) => entry.message.includes('zha_toolkit'))).toBe(true);
    expect(loaders.some((entry) => entry.message.includes('spook'))).toBe(true);
    expect(parseHomeAssistantLog(['2026-09-06 01:11:37.916 WARNING (Thread-1 (_monitor)) [homeassistant.util.logging] Module custom_components.monitor_docker.sensor is logging too frequently. 200 messages since last count'], { includeWarnings: true })[0]).toMatchObject({ component: 'homeassistant.util.logging', level: 'WARNING' });
  });

  it('attaches redacted source lines naming the concrete subject to every signature', () => {
    const entries = parseHomeAssistantLog([
      '2026-09-06 01:11:37 ERROR (MainThread) [homeassistant.loader] We found a custom integration spook which has not been tested token=secret-value',
      '2026-09-06 01:12:37 ERROR (MainThread) [homeassistant.loader] We found a custom integration spook which has not been tested token=secret-value'
    ]);
    const plan = classifySignatures(entries, [], { now: '2026-09-06T02:00:00.000Z' });

    expect(plan.signatures).toHaveLength(1);
    expect(plan.signatures[0]?.sourceLines).toHaveLength(2);
    expect(JSON.stringify(plan.signatures[0]?.sourceLines)).toContain('spook');
    expect(JSON.stringify(plan.signatures[0]?.sourceLines)).not.toContain('secret-value');
  });

  it('keeps warnings opt-in and normalizes volatile values without retaining raw identifiers', () => {
    const line = '2026-07-29 12:00:00 WARNING (MainThread) [custom.integration] retry id=42 request=0xabcdef1234';
    expect(parseHomeAssistantLog([line])).toEqual([]);
    expect(parseHomeAssistantLog([line], { includeWarnings: true })[0]).toMatchObject({ normalizedMessage: 'retry id=<number> request=<id>' });
  });

  it('groups a multiline traceback under its timestamped header and keeps the original signature stable', () => {
    const header = '2026-08-14 12:00:00 ERROR (MainThread) [custom_components.private_domain] Update failed for sensor.private_room';
    const entries = parseHomeAssistantLog([
      header,
      'Traceback (most recent call last):',
      '  File "/config/custom_components/private_domain/coordinator.py", line 42, in async_refresh',
      '  File "/config/custom_components/private_domain/device_ABCD12345678.py", line 43, in leak_serial',
      '  File "/config/custom_components/private_domain/coordinator.py", line 44, in handler_ABCD12345678',
      '    payload = {"token": "private-token", "email": "owner@example.test"}',
      'ConnectionError: failed to call https://192.0.2.10/api for device Kitchen Sensor serial ABCD12345678',
      '2026-08-14 12:01:00 INFO (MainThread) [homeassistant.core] harmless boundary',
      'unrelated continuation that must not be attached',
      '2026-08-14 12:02:00 ERROR (MainThread) [custom_components.private_domain] Update failed for sensor.private_room'
    ]);
    const headerOnly = parseHomeAssistantLog([header]);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.signature).toBe(headerOnly[0]?.signature);
    expect(entries[0]).toMatchObject({
      safeExcerpt: {
        lines: [
          'Traceback (redacted)',
          'File "custom_components/[hidden]/coordinator.py", line 42, in async_refresh',
          'ConnectionError'
        ],
        truncated: true,
        redacted: true
      }
    });
    const serialized = JSON.stringify(entries[0]?.safeExcerpt);
    for (const privateValue of ['private_domain', 'private-token', 'owner@example.test', '192.0.2.10', 'Kitchen Sensor', 'ABCD12345678', 'sensor.private_room']) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('bounds structurally safe trace excerpts by lines, characters, and UTF-8 bytes', () => {
    const lines = ['2026-08-14 12:00:00 CRITICAL [homeassistant.components.private_domain] Failure'];
    for (let index = 0; index < 20; index += 1) {
      lines.push(`  File "/usr/src/homeassistant/homeassistant/components/private_domain/${'module'.repeat(120)}${index}.py", line ${index + 1}, in handler_${index}`);
    }
    lines.push('RuntimeError: private exception detail');

    const excerpt = parseHomeAssistantLog(lines)[0]?.safeExcerpt;

    expect(excerpt?.lines.length).toBeLessThanOrEqual(12);
    expect(excerpt?.lines.every((line) => line.length <= 512)).toBe(true);
    expect(Buffer.byteLength(excerpt?.lines.join('\n') ?? '', 'utf8')).toBeLessThanOrEqual(4096);
    expect(excerpt).toMatchObject({ truncated: true, redacted: true });
    expect(JSON.stringify(excerpt)).not.toContain('private_domain');
    expect(JSON.stringify(excerpt)).not.toContain('private exception detail');
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

  it('debounces sporadic network timeout errors as WARNING but promotes them to ERROR when meeting 5-in-30m threshold', () => {
    // Case A: Sporadic timeouts (e.g. 2 occurrences in 10 minutes) -> WARNING
    const sporadicEntries = parseHomeAssistantLog([
      '2026-08-24 05:26:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Timeout while contacting DNS servers',
      '2026-08-24 05:28:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Timeout while contacting DNS servers'
    ]);
    const sporadicPlan = classifySignatures(sporadicEntries, [], { now: '2026-08-24T12:00:00.000Z' });
    expect(sporadicPlan.signatures[0]?.level).toBe('WARNING');

    // Case B: Persistent network breakdown (5 occurrences within 20 minutes) -> ERROR
    const persistentEntries = parseHomeAssistantLog([
      '2026-08-24 05:10:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Timeout while contacting DNS servers',
      '2026-08-24 05:15:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Timeout while contacting DNS servers',
      '2026-08-24 05:20:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Timeout while contacting DNS servers',
      '2026-08-24 05:25:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Timeout while contacting DNS servers',
      '2026-08-24 05:30:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Timeout while contacting DNS servers'
    ]);
    const persistentPlan = classifySignatures(persistentEntries, [], { now: '2026-08-24T12:00:00.000Z' });
    expect(persistentPlan.signatures[0]?.level).toBe('ERROR');

    // Case C: 5 occurrences spread over 5 hours (no single 30m window has 5) -> WARNING
    const sparseEntries = parseHomeAssistantLog([
      '2026-08-24 01:00:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Timeout while contacting DNS servers',
      '2026-08-24 02:00:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Timeout while contacting DNS servers',
      '2026-08-24 03:00:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Timeout while contacting DNS servers',
      '2026-08-24 04:00:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Timeout while contacting DNS servers',
      '2026-08-24 05:00:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Timeout while contacting DNS servers'
    ]);
    const sparsePlan = classifySignatures(sparseEntries, [], { now: '2026-08-24T12:00:00.000Z' });
    expect(sparsePlan.signatures[0]?.level).toBe('WARNING');

    // Case D: Non-network error (e.g. syntax or auth failure) remains ERROR even on 1 occurrence
    const authErrorEntries = parseHomeAssistantLog([
      '2026-08-24 05:26:00 ERROR (MainThread) [homeassistant.components.google.coordinator] Invalid authentication credentials'
    ]);
    const authPlan = classifySignatures(authErrorEntries, [], { now: '2026-08-24T12:00:00.000Z' });
    expect(authPlan.signatures[0]?.level).toBe('ERROR');
  });

  it('chunks log lines for AI extraction by lines, bytes, and batch cap with stable numbering', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    const chunked = chunkLogLinesForExtraction(lines, { maxLinesPerBatch: 2, maxBatches: 10 });
    expect(chunked.truncated).toBe(false);
    expect(chunked.batches.map((batch) => batch.lines)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(chunked.batches.map((batch) => batch.startLine)).toEqual([1, 3, 5]);

    const capped = chunkLogLinesForExtraction(lines, { maxLinesPerBatch: 2, maxBatches: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.batches).toHaveLength(2);

    const byteCapped = chunkLogLinesForExtraction(['x'.repeat(100), 'y'.repeat(100)], { maxBytesPerBatch: 120, maxBatches: 10 });
    expect(byteCapped.batches.map((batch) => batch.lines)).toEqual([['x'.repeat(100)], ['y'.repeat(100)]]);
  });

  it('builds deterministic parsed entries from validated AI output with timestamp fallback', () => {
    const entry = buildParsedEntry({ timestamp: '2026-08-24 05:26:00', level: 'error', component: 'Custom.Component', message: 'Boom id=42' }, '2026-08-24T06:00:00.000Z');
    expect(entry).toMatchObject({ level: 'ERROR', component: 'custom.component', normalizedMessage: 'boom id=<number>' });
    expect(entry?.signature).toBe(parseHomeAssistantLog(['2026-08-24 05:26:00 ERROR (MainThread) [custom.component] Boom id=99'])[0]?.signature);

    const fallback = buildParsedEntry({ timestamp: '', level: 'CRITICAL', component: 'ha.core', message: 'No timestamp here' }, '2026-08-24T06:00:00.000Z');
    expect(fallback).toMatchObject({ at: '2026-08-24T06:00:00.000Z', level: 'CRITICAL' });

    expect(buildParsedEntry({ timestamp: '2026-08-24 05:26:00', level: 'INFO', component: 'ha.core', message: 'noise' }, '2026-08-24T06:00:00.000Z')).toBeNull();
    expect(buildParsedEntry({ timestamp: '2026-08-24 05:26:00', level: 'ERROR', component: ' ', message: 'noise' }, '2026-08-24T06:00:00.000Z')).toBeNull();
    expect(buildParsedEntry({ timestamp: '2026-08-24 05:26:00', level: 'ERROR', component: 'ha.core', message: '  ' }, '2026-08-24T06:00:00.000Z')).toBeNull();
  });
});
