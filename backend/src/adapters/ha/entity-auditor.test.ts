import { describe, expect, it } from 'vitest';
import { auditEntityStates, type RawEntityState } from './entity-auditor.js';

describe('auditEntityStates', () => {
  const nowIso = '2026-08-16T12:00:00.000Z';

  it('categorizes unavailable and unknown entities', () => {
    const states: RawEntityState[] = [
      {
        entity_id: 'sensor.living_room_temp',
        state: 'unavailable',
        last_updated: '2026-08-16T11:00:00.000Z',
        attributes: { friendly_name: 'Living Room Temp' }
      },
      {
        entity_id: 'light.kitchen_light',
        state: 'unknown',
        last_updated: '2026-08-16T10:00:00.000Z'
      }
    ];

    const result = auditEntityStates(states, nowIso);

    expect(result.totalAudited).toBe(2);
    expect(result.unavailableCount).toBe(2);
    expect(result.staleCount).toBe(0);
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({
      entityId: 'light.kitchen_light',
      name: 'light.kitchen_light',
      domain: 'light',
      state: 'unknown',
      issueType: 'unavailable',
      lastUpdated: '2026-08-16T10:00:00.000Z'
    });
    expect(result.entities[1]).toEqual({
      entityId: 'sensor.living_room_temp',
      name: 'Living Room Temp',
      domain: 'sensor',
      state: 'unavailable',
      issueType: 'unavailable',
      lastUpdated: '2026-08-16T11:00:00.000Z'
    });
  });

  it('categorizes stale (>24h inactive) entities for monitored domains', () => {
    const states: RawEntityState[] = [
      {
        entity_id: 'sensor.bedroom_motion',
        state: 'on',
        last_updated: '2026-08-15T10:00:00.000Z', // 26h ago
        attributes: { friendly_name: 'Bedroom Motion' }
      },
      {
        entity_id: 'climate.main_hvac',
        state: 'heat',
        last_changed: '2026-08-14T12:00:00.000Z', // 48h ago
        attributes: { friendly_name: 'Main HVAC' }
      },
      {
        entity_id: 'binary_sensor.front_door',
        state: 'off',
        last_updated: '2026-08-16T11:00:00.000Z' // 1h ago (fresh)
      }
    ];

    const result = auditEntityStates(states, nowIso);

    expect(result.totalAudited).toBe(3);
    expect(result.unavailableCount).toBe(0);
    expect(result.staleCount).toBe(2);
    expect(result.entities).toHaveLength(2);

    expect(result.entities.map((e) => e.entityId)).toEqual([
      'climate.main_hvac',
      'sensor.bedroom_motion'
    ]);
    expect(result.entities[0].issueType).toBe('stale');
    expect(result.entities[1].issueType).toBe('stale');
  });

  it('excludes system entities like sun and zone from totalAudited and issues', () => {
    const states: RawEntityState[] = [
      {
        entity_id: 'sun.sun',
        state: 'above_horizon',
        last_updated: '2026-08-10T00:00:00.000Z' // very old
      },
      {
        entity_id: 'zone.home',
        state: 'zoning',
        last_updated: '2026-08-10T00:00:00.000Z'
      },
      {
        entity_id: 'sensor.active_sensor',
        state: '21.5',
        last_updated: '2026-08-16T11:30:00.000Z'
      }
    ];

    const result = auditEntityStates(states, nowIso);

    expect(result.totalAudited).toBe(1);
    expect(result.unavailableCount).toBe(0);
    expect(result.staleCount).toBe(0);
    expect(result.entities).toHaveLength(0);
  });

  it('respects custom maxStaleHours parameter', () => {
    const states: RawEntityState[] = [
      {
        entity_id: 'sensor.temp',
        state: '20',
        last_updated: '2026-08-16T06:00:00.000Z' // 6h ago
      }
    ];

    const defaultResult = auditEntityStates(states, nowIso, 24);
    expect(defaultResult.staleCount).toBe(0);

    const strictResult = auditEntityStates(states, nowIso, 5);
    expect(strictResult.staleCount).toBe(1);
    expect(strictResult.entities[0].entityId).toBe('sensor.temp');
  });

  it('sorts entities so unavailable come first, then stale, then by domain and entityId', () => {
    const states: RawEntityState[] = [
      {
        entity_id: 'switch.yard_light',
        state: 'off',
        last_updated: '2026-08-10T00:00:00.000Z' // stale
      },
      {
        entity_id: 'sensor.zebra',
        state: 'unavailable' // unavailable
      },
      {
        entity_id: 'climate.ac',
        state: 'unavailable' // unavailable
      },
      {
        entity_id: 'cover.garage',
        state: 'open',
        last_updated: '2026-08-10T00:00:00.000Z' // stale
      }
    ];

    const result = auditEntityStates(states, nowIso);

    expect(result.entities.map((e) => `${e.issueType}:${e.entityId}`)).toEqual([
      'unavailable:climate.ac',
      'unavailable:sensor.zebra',
      'stale:cover.garage',
      'stale:switch.yard_light'
    ]);
  });
});
