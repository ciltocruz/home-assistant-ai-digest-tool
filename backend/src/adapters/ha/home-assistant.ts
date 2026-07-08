import type { CollectedFact, CollectionResult, Collector, UnsupportedSignal } from '../../domain/collectors.js';
import type { Incident, IncidentDetector, IncidentSeverity } from '../../domain/detectors.js';

export type HomeAssistantState = {
  entity_id: string;
  state: string;
  last_changed: string;
  last_updated: string;
  attributes?: Record<string, unknown>;
};

export interface HomeAssistantApiClient {
  listStates(): Promise<HomeAssistantState[]>;
}

export interface HomeAssistantLogReader {
  readLogLines(): Promise<string[]>;
}

type HomeAssistantFactKind = 'state' | 'log';

type HomeAssistantFactAttributes = Record<string, unknown> & {
  kind: HomeAssistantFactKind;
  entityId?: string;
  domain?: string;
  state?: string;
  lastChanged?: string;
  lastUpdated?: string;
  area?: string;
  level?: string;
  message?: string;
};

type CollectorOptions = {
  apiClient: HomeAssistantApiClient;
  logReader: HomeAssistantLogReader;
  now?: () => string;
  maxStates?: number;
  maxLogLines?: number;
};

type DetectorOptions = {
  now?: () => string;
  staleAfterHours?: number;
};

const DEFAULT_MAX_STATES = 500;
const DEFAULT_MAX_LOG_LINES = 200;
const DEFAULT_STALE_AFTER_HOURS = 24;
const SECRET_PATTERNS = [
  /\bBearer\s+[-._~+/=A-Za-z0-9]+\b/gi,
  /\b(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|secret)\s*[:=]\s*([^\s&]+)/gi
];

export class DockerCoreUnsupportedSignalReporter {
  unsupportedSignals(): UnsupportedSignal[] {
    return [
      {
        source: 'supervisor',
        reason: 'Supervisor API is unavailable in Docker/Core mode; use Docker/Core collectors instead.'
      },
      {
        source: 'supervisor_repairs',
        reason: 'Supervisor repairs and add-on health signals are unsupported in Docker/Core mode.'
      }
    ];
  }
}

export class HomeAssistantFactsCollector implements Collector {
  readonly id = 'home-assistant-facts';

  constructor(
    private readonly options: CollectorOptions,
    private readonly unsupportedReporter = new DockerCoreUnsupportedSignalReporter()
  ) {}

  async collect(): Promise<CollectionResult> {
    const observedAt = this.options.now?.() ?? new Date().toISOString();
    const states = (await this.options.apiClient.listStates()).slice(0, this.options.maxStates ?? DEFAULT_MAX_STATES);
    const logLines = (await this.options.logReader.readLogLines()).slice(0, this.options.maxLogLines ?? DEFAULT_MAX_LOG_LINES);

    return {
      facts: [...states.map((state) => stateFact(state, observedAt)), ...logLines.map((line, index) => logFact(line, index, observedAt))],
      unsupportedSignals: this.unsupportedReporter.unsupportedSignals()
    };
  }
}

export class HomeAssistantIncidentDetector implements IncidentDetector {
  readonly id = 'home-assistant-incidents';

  constructor(private readonly options: DetectorOptions = {}) {}

  async detect(facts: CollectedFact[]): Promise<Incident[]> {
    const detectedAt = this.options.now?.() ?? new Date().toISOString();
    return facts.flatMap((fact) => {
      const attributes = fact.attributes as HomeAssistantFactAttributes | undefined;
      if (attributes?.kind === 'state') return detectStateIncident(attributes, detectedAt, this.options.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS);
      if (attributes?.kind === 'log') return detectLogIncident(attributes, fact.id, detectedAt);
      return [];
    });
  }
}

function stateFact(state: HomeAssistantState, observedAt: string): CollectedFact {
  const [domain = 'entity'] = state.entity_id.split('.');
  const area = stringAttribute(state.attributes, 'area_id') ?? stringAttribute(state.attributes, 'area');
  return {
    id: `ha_state:${state.entity_id}`,
    source: 'ha_state',
    observedAt,
    summary: `${state.entity_id} is ${state.state}`,
    attributes: {
      kind: 'state',
      entityId: state.entity_id,
      domain,
      state: state.state,
      lastChanged: state.last_changed,
      lastUpdated: state.last_updated,
      area,
      friendlyName: stringAttribute(state.attributes, 'friendly_name')
    }
  };
}

function logFact(line: string, index: number, observedAt: string): CollectedFact {
  const message = redactText(line);
  return {
    id: `ha_log:${observedAt}:${index}`,
    source: 'ha_log',
    observedAt,
    summary: message,
    attributes: {
      kind: 'log',
      level: logLevel(line),
      message
    }
  };
}

function detectStateIncident(attributes: HomeAssistantFactAttributes, detectedAt: string, staleAfterHours: number): Incident[] {
  if (!attributes.entityId || !attributes.state) return [];
  const domain = attributes.domain ?? 'entity';
  const type = domain === 'automation' ? 'automation' : 'entity';
  if (attributes.state === 'unavailable' || attributes.state === 'unknown') {
    return [incident(`ha:${type}:${attributes.entityId}:${attributes.state}`, type, 'warning', attributes, `${attributes.entityId} is ${attributes.state}`, detectedAt)];
  }
  if (isStale(attributes.lastUpdated, detectedAt, staleAfterHours)) {
    return [incident(`ha:entity:${attributes.entityId}:stale`, 'entity', 'warning', attributes, `${attributes.entityId} has not updated for ${staleAfterHours}+ hours`, detectedAt)];
  }
  return [];
}

function detectLogIncident(attributes: HomeAssistantFactAttributes, factId: string, detectedAt: string): Incident[] {
  const message = attributes.message ?? '';
  const lower = message.toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}/.test(message)) return [];
  if (!/(error|failed|warning)/i.test(message)) return [];
  if (lower.includes('monitor_docker') || lower.includes('docker container')) return [logIncident(factId, 'docker', 'warning', message, detectedAt)];
  if (lower.includes('recorder')) return [logIncident(factId, 'recorder', 'critical', message, detectedAt)];
  if (lower.includes('config_entries') || lower.includes('config entry') || lower.includes('integration')) {
    return [logIncident(factId, 'integration', 'warning', message, detectedAt)];
  }
  if (lower.includes('automation')) return [logIncident(factId, 'automation', 'warning', message, detectedAt)];
  if (lower.includes('homeassistant.components.')) return [logIncident(factId, 'integration', 'warning', message, detectedAt)];
  if (lower.includes('homeassistant.runner') || lower.includes('shutdown')) return [logIncident(factId, 'system', 'info', message, detectedAt)];
  return [logIncident(factId, 'log', attributes.level === 'ERROR' ? 'warning' : 'info', message, detectedAt)];
}

function incident(
  id: string,
  type: string,
  severity: IncidentSeverity,
  attributes: HomeAssistantFactAttributes,
  summary: string,
  detectedAt: string
): Incident {
  return {
    id,
    type,
    severity,
    area: attributes.area,
    summary,
    redactedEvidence: [
      `entity=${attributes.entityId}`,
      `state=${attributes.state}`,
      attributes.lastChanged ? `lastChanged=${attributes.lastChanged}` : 'lastChanged=unknown',
      attributes.lastUpdated ? `lastUpdated=${attributes.lastUpdated}` : 'lastUpdated=unknown'
    ],
    detectedAt
  };
}

function logIncident(factId: string, type: string, severity: IncidentSeverity, message: string, detectedAt: string): Incident {
  return {
    id: `ha:log:${type}:${factId}`,
    type,
    severity,
    summary: message,
    redactedEvidence: [message],
    detectedAt
  };
}

function logLevel(line: string): string {
  if (/\bERROR\b/i.test(line)) return 'ERROR';
  if (/\bWARNING\b/i.test(line)) return 'WARNING';
  return 'INFO';
}

function isStale(updatedAt: string | undefined, observedAt: string, staleAfterHours: number): boolean {
  if (!updatedAt) return false;
  const ageHours = (Date.parse(observedAt) - Date.parse(updatedAt)) / 3_600_000;
  return Number.isFinite(ageHours) && ageHours >= staleAfterHours;
}

function stringAttribute(attributes: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = attributes?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function redactText(value: string): string {
  return SECRET_PATTERNS.reduce((output, pattern) => output.replace(pattern, '[REDACTED]'), value);
}
