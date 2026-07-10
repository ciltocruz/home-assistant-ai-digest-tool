import { describe, expect, it } from 'vitest';
import {
  DockerCoreUnsupportedSignalReporter,
  HomeAssistantFactsCollector,
  HomeAssistantIncidentDetector,
  type HomeAssistantApiClient,
  type HomeAssistantLogReader
} from './home-assistant.js';

const now = '2026-07-02T12:00:00.000Z';

describe('Home Assistant collectors and detectors', () => {
  it('collects normalized Docker/Core facts and marks Supervisor-only signals unsupported', async () => {
    const apiClient: HomeAssistantApiClient = {
      async listStates() {
        return [
          state('sensor.kitchen_temperature', '21.5', '2026-07-02T11:50:00.000Z', { friendly_name: 'Kitchen Temperature' }),
          state('light.hall', 'on', '2026-07-02T11:55:00.000Z', { area_id: 'Hall' })
        ];
      }
    };
    const logReader: HomeAssistantLogReader = {
      async readLogLines() {
        return ['2026-07-02 11:59:00 ERROR (MainThread) [homeassistant.components.recorder] Database failed token=secret123'];
      }
    };

    const result = await new HomeAssistantFactsCollector({ apiClient, logReader, now: () => now }).collect();

    expect(result.facts.map((fact) => fact.source)).toEqual(['ha_state', 'ha_state', 'ha_log']);
    expect(result.facts[0]).toMatchObject({
      id: 'ha_state:sensor.kitchen_temperature',
      observedAt: now,
      summary: 'sensor.kitchen_temperature is 21.5',
      attributes: {
        lastChanged: '2026-07-02T11:50:00.000Z',
        lastUpdated: '2026-07-02T11:50:00.000Z'
      }
    });
    expect(JSON.stringify(result.facts)).not.toContain('secret123');
    expect(result.unsupportedSignals).toEqual(
      new DockerCoreUnsupportedSignalReporter().unsupportedSignals()
    );
  });

  it('detects unavailable, unknown, stale, and suspicious automation incidents from HA facts', async () => {
    const facts = await new HomeAssistantFactsCollector({
      apiClient: {
        async listStates() {
          return [
            state('switch.pool_pump', 'unavailable', '2026-07-02T11:00:00.000Z', { area_id: 'Garden' }),
            state('sensor.garage_door', 'unknown', '2026-07-02T10:00:00.000Z'),
            state('sensor.freezer_temperature', '-18', '2026-07-01T11:00:00.000Z'),
            state('automation.morning_routine', 'unavailable', '2026-07-02T11:58:00.000Z')
          ];
        }
      },
      logReader: { async readLogLines() { return []; } },
      now: () => now
    }).collect();

    const incidents = await new HomeAssistantIncidentDetector({ now: () => now, staleAfterHours: 12 }).detect(facts.facts);

    expect(incidents.map((incident) => incident.id)).toEqual([
      'ha:entity:switch.pool_pump:unavailable',
      'ha:entity:sensor.garage_door:unknown',
      'ha:entity:sensor.freezer_temperature:stale',
      'ha:automation:automation.morning_routine:unavailable'
    ]);
    expect(incidents[0]).toMatchObject({ type: 'entity', severity: 'warning', area: 'Garden' });
    expect(incidents[3]).toMatchObject({ type: 'automation', severity: 'warning' });
  });

  it('detects recorder, integration, and automation log incidents without leaking secrets', async () => {
    const facts = await new HomeAssistantFactsCollector({
      apiClient: { async listStates() { return []; } },
      logReader: {
        async readLogLines() {
          return [
            '2026-07-02 12:00:00 ERROR [homeassistant.components.recorder] Database migration failed Bearer rawsecret',
            '2026-07-02 12:00:01 WARNING [homeassistant.config_entries] Config entry setup failed for mqtt password=tiny',
            '2026-07-02 12:00:02 ERROR [homeassistant.components.automation] Error while executing automation kitchen'
          ];
        }
      },
      now: () => now
    }).collect();

    const incidents = await new HomeAssistantIncidentDetector({ now: () => now }).detect(facts.facts);

    expect(incidents.map((incident) => [incident.type, incident.severity])).toEqual([
      ['recorder', 'critical'],
      ['integration', 'warning'],
      ['automation', 'warning']
    ]);
    expect(JSON.stringify(incidents)).not.toContain('rawsecret');
    expect(JSON.stringify(incidents)).not.toContain('tiny');
  });

  it('detects real-shape Docker/Core Home Assistant log incidents from sanitized fixtures', async () => {
    const facts = await new HomeAssistantFactsCollector({
      apiClient: { async listStates() { return []; } },
      logReader: {
        async readLogLines() {
          return [
            '2026-07-08 10:15:30.456 ERROR (MainThread) [custom_components.monitor_docker.helpers] Docker container media_downloader is unavailable after 3 retries on docker_host',
            '2026-07-08 10:15:31.456 WARNING (MainThread) [custom_components.monitor_docker.helpers] Failed to update container ml_worker; retrying in 30 seconds',
            '2026-07-08 10:16:00.000 WARNING (MainThread) [homeassistant.components.tplink] Config entry docker_router for tplink integration not ready yet; Retrying in background',
            '2026-07-08 10:16:01.000 ERROR (MainThread) [homeassistant.components.tplink.coordinator] Unexpected error fetching docker_router data',
            'Traceback (most recent call last):',
            '  File "/usr/src/homeassistant/homeassistant/helpers/update_coordinator.py", line 380, in _async_refresh',
            'RuntimeError: Session is closed',
            '2026-07-08 10:17:00.000 WARNING (MainThread) [homeassistant.runner] Shutdown timeout, cancelling pending tasks'
          ];
        }
      },
      now: () => now
    }).collect();

    const incidents = await new HomeAssistantIncidentDetector({ now: () => now }).detect(facts.facts);

    expect(incidents.map((incident) => [incident.type, incident.severity])).toEqual([
      ['docker', 'warning'],
      ['docker', 'warning'],
      ['integration', 'warning'],
      ['integration', 'warning'],
      ['system', 'info']
    ]);
    expect(JSON.stringify(incidents)).toContain('media_downloader');
    expect(JSON.stringify(incidents)).toContain('ml_worker');
    expect(JSON.stringify(incidents)).not.toContain('cisne');
  });

  it('redacts common Home Assistant token key variants from log facts and incidents', async () => {
    const facts = await new HomeAssistantFactsCollector({
      apiClient: { async listStates() { return []; } },
      logReader: {
        async readLogLines() {
          return [
            '2026-07-02 12:00:00 ERROR [homeassistant.auth] Login failed access_token=access-secret refresh_token=refresh-secret'
          ];
        }
      },
      now: () => now
    }).collect();

    const incidents = await new HomeAssistantIncidentDetector({ now: () => now }).detect(facts.facts);

    expect(JSON.stringify(facts.facts)).not.toContain('access-secret');
    expect(JSON.stringify(facts.facts)).not.toContain('refresh-secret');
    expect(JSON.stringify(incidents)).not.toContain('access-secret');
    expect(JSON.stringify(incidents)).not.toContain('refresh-secret');
  });

  it('does not mark an entity stale when last_updated is recent even if last_changed is old', async () => {
    const facts = await new HomeAssistantFactsCollector({
      apiClient: {
        async listStates() {
          return [
            state('sensor.power_meter', '100', '2026-07-01T00:00:00.000Z', {}, '2026-07-02T11:59:00.000Z')
          ];
        }
      },
      logReader: { async readLogLines() { return []; } },
      now: () => now
    }).collect();

    const incidents = await new HomeAssistantIncidentDetector({ now: () => now, staleAfterHours: 12 }).detect(facts.facts);

    expect(incidents).toEqual([]);
  });
});

function state(entityId: string, value: string, changedAt: string, attributes: Record<string, unknown> = {}, updatedAt = changedAt) {
  return {
    entity_id: entityId,
    state: value,
    last_changed: changedAt,
    last_updated: updatedAt,
    attributes
  };
}
