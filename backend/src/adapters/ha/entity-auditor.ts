import type { EntityIssueDto, StaleEntitiesResponse } from '@ha-digest/shared';

export type RawEntityState = {
  entity_id: string;
  state: string;
  last_updated?: string;
  last_changed?: string;
  attributes?: {
    friendly_name?: string;
    [key: string]: unknown;
  };
};

const STALE_DOMAINS = new Set([
  'sensor',
  'climate',
  'binary_sensor',
  'light',
  'switch',
  'lock',
  'cover'
]);

const SYSTEM_DOMAINS = new Set(['sun', 'zone']);

export type DeviceInfoMap = Map<string, { deviceId?: string; deviceName?: string }>;

export function auditEntityStates(
  rawStates: RawEntityState[],
  nowIso: string,
  maxStaleHours = 24,
  deviceMap?: DeviceInfoMap
): StaleEntitiesResponse {
  const nowMs = Date.parse(nowIso);
  let totalAudited = 0;
  const issues: EntityIssueDto[] = [];

  for (const raw of rawStates) {
    const domain = raw.entity_id.split('.')[0] || '';
    if (SYSTEM_DOMAINS.has(domain)) {
      continue;
    }

    totalAudited += 1;

    const stateLower = raw.state.toLowerCase();
    const isUnavailable = stateLower === 'unavailable' || stateLower === 'unknown';
    const lastUpdatedTs = raw.last_updated || raw.last_changed || nowIso;
    const device = deviceMap?.get(raw.entity_id);

    if (isUnavailable) {
      const name = raw.attributes?.friendly_name || raw.entity_id;
      issues.push({
        entityId: raw.entity_id,
        name,
        domain,
        state: raw.state,
        issueType: 'unavailable',
        lastUpdated: lastUpdatedTs,
        ...(device?.deviceName ? { deviceName: device.deviceName } : {}),
        ...(device?.deviceId ? { deviceId: device.deviceId } : {})
      });
    } else if (STALE_DOMAINS.has(domain)) {
      if (lastUpdatedTs) {
        const updatedMs = Date.parse(lastUpdatedTs);
        if (!isNaN(updatedMs)) {
          const diffHours = (nowMs - updatedMs) / (1000 * 60 * 60);
          if (diffHours > maxStaleHours) {
            const name = raw.attributes?.friendly_name || raw.entity_id;
            issues.push({
              entityId: raw.entity_id,
              name,
              domain,
              state: raw.state,
              issueType: 'stale',
              lastUpdated: lastUpdatedTs,
              ...(device?.deviceName ? { deviceName: device.deviceName } : {}),
              ...(device?.deviceId ? { deviceId: device.deviceId } : {})
            });
          }
        }
      }
    }
  }

  issues.sort((a, b) => {
    if (a.issueType !== b.issueType) {
      return a.issueType === 'unavailable' ? -1 : 1;
    }
    const domainCompare = a.domain.localeCompare(b.domain);
    if (domainCompare !== 0) return domainCompare;
    return a.entityId.localeCompare(b.entityId);
  });

  const unavailableCount = issues.filter((i) => i.issueType === 'unavailable').length;
  const staleCount = issues.filter((i) => i.issueType === 'stale').length;

  return {
    unavailableCount,
    staleCount,
    totalAudited,
    entities: issues
  };
}
