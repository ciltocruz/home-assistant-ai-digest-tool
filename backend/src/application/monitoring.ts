export type MonitoringPriority = 'critical' | 'high' | 'normal';

export type MonitoringEntity = {
  entityId: string;
  domain: string;
  name?: string;
};

export type MonitoringPreference = {
  entityId: string;
  enabled?: boolean;
  priority?: MonitoringPriority;
};

export type MonitoringProposal = {
  entityId: string;
  priority: MonitoringPriority;
  explanation: string;
  enabled: boolean;
};

export function proposeMonitoredEntities(
  entities: MonitoringEntity[],
  preferences: MonitoringPreference[] = []
): MonitoringProposal[] {
  const preferencesByEntity = new Map(preferences.map((preference) => [preference.entityId, preference]));

  return entities.map((entity) => proposalFor(entity, preferencesByEntity.get(entity.entityId)));
}

function proposalFor(entity: MonitoringEntity, preference: MonitoringPreference | undefined): MonitoringProposal {
  if (preference?.enabled === false) {
    return {
      entityId: entity.entityId,
      priority: defaultPriority(entity),
      explanation: 'User preference disabled this entity.',
      enabled: false
    };
  }

  if (preference?.priority) {
    return {
      entityId: entity.entityId,
      priority: preference.priority,
      explanation: `User preference selected ${preference.priority} priority.`,
      enabled: true
    };
  }

  return {
    entityId: entity.entityId,
    priority: defaultPriority(entity),
    explanation: defaultExplanation(entity),
    enabled: true
  };
}

function defaultPriority(entity: MonitoringEntity): MonitoringPriority {
  return entity.domain === 'binary_sensor' || entity.domain === 'automation' ? 'high' : 'normal';
}

function defaultExplanation(entity: MonitoringEntity): string {
  if (entity.domain === 'binary_sensor') return 'Binary sensors can indicate an immediate state change.';
  if (entity.domain === 'automation') return 'Automations are prioritized because failed runs can affect other entities.';
  return 'Sensors are monitored at the default priority.';
}
