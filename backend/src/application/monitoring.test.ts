import { describe, expect, it } from 'vitest';
import { proposeMonitoredEntities } from './monitoring.js';

describe('monitoring proposals', () => {
  it('prioritizes safety-relevant entities with explanations while retaining normal entities', () => {
    const proposals = proposeMonitoredEntities([
      { entityId: 'binary_sensor.front_door', domain: 'binary_sensor', name: 'Front door' },
      { entityId: 'sensor.living_room_temperature', domain: 'sensor', name: 'Living room temperature' }
    ]);

    expect(proposals).toEqual([
      {
        entityId: 'binary_sensor.front_door',
        priority: 'high',
        explanation: 'Binary sensors can indicate an immediate state change.',
        enabled: true
      },
      {
        entityId: 'sensor.living_room_temperature',
        priority: 'normal',
        explanation: 'Sensors are monitored at the default priority.',
        enabled: true
      }
    ]);
  });

  it('applies user enablement and priority preferences to future digest monitoring', () => {
    const proposals = proposeMonitoredEntities(
      [
        { entityId: 'automation.night_alarm', domain: 'automation' },
        { entityId: 'sensor.guest_room_temperature', domain: 'sensor' }
      ],
      [
        { entityId: 'automation.night_alarm', priority: 'critical' },
        { entityId: 'sensor.guest_room_temperature', enabled: false }
      ]
    );

    expect(proposals).toEqual([
      {
        entityId: 'automation.night_alarm',
        priority: 'critical',
        explanation: 'User preference selected critical priority.',
        enabled: true
      },
      {
        entityId: 'sensor.guest_room_temperature',
        priority: 'normal',
        explanation: 'User preference disabled this entity.',
        enabled: false
      }
    ]);
  });
});
