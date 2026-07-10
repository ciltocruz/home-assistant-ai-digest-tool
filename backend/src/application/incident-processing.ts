import type { IgnoreRuleDto, PrivacyLevel } from '@ha-digest/shared';
import type { Incident } from '../domain/detectors.js';
import type { RedactedDigestInput, StructuredDigest } from '../domain/providers.js';
import type { RenderedDigest } from '../domain/renderers.js';

type BuildDigestInput = Omit<RedactedDigestInput, 'incidents' | 'notes' | 'redactionReport'> & {
  privacyLevel: PrivacyLevel;
  incidents: Incident[];
  notes: Array<{ id: string; text: string; occurredAt: string }>;
};

type BatterySample = { at: string; level: number };
type BatteryEntity = { entityId: string; name: string; level: number; observedAt: string };

const SECRET_PATTERNS = [
  /\bBearer\s+[-._~+/=A-Za-z0-9]+\b/gi,
  /\b(?:token|api[_-]?key|password|secret)\s*[:=]\s*([^\s&]+)/gi,
  /\b[A-Za-z0-9_-]{12,}\b/g
];

const SENSITIVE_KEY_PATTERN = /(?:token|api[_-]?key|password|secret)/i;
const MAX_PROVIDER_ARRAY_ITEMS = 10;
const MAX_PROVIDER_OBJECT_KEYS = 50;
const MAX_PROVIDER_DEPTH = 4;

export function buildRedactedDigestInput(input: BuildDigestInput): RedactedDigestInput {
  const report = new Set<string>();
  const redact = (value: string) => redactText(value, report);
  return {
    ...input,
    entityStats: sanitizeProviderRecord(input.entityStats, report),
    incidents: input.incidents.map((incident) => ({
      ...incident,
      summary: redact(incident.summary),
      redactedEvidence: incident.redactedEvidence.map(redact).slice(0, 10)
    })),
    notes: input.notes.map((note) => ({ ...note, text: redact(note.text).slice(0, 1000) })),
    unsupportedSignals: input.unsupportedSignals.map((signal) => ({ source: redact(signal.source), reason: redact(signal.reason) })),
    redactionReport: [...report]
  };
}

export async function renderSafeMarkdown(digest: StructuredDigest): Promise<RenderedDigest> {
  const lines = [`# Home Assistant Digest`, '', `**Severity:** ${digest.severity}`, '', safeInline(digest.summary), ''];
  if (digest.attentionItems.length > 0) {
    lines.push('## Attention items');
    for (const item of digest.attentionItems) {
      lines.push('', `- **${safeInline(item.title)}** (${item.severity}): ${safeInline(item.detail)}`);
    }
  }
  return { format: 'markdown', body: lines.join('\n') };
}

export function applyIgnoreRules(incidents: Incident[], rules: IgnoreRuleDto[], at: string): Incident[] {
  const now = Date.parse(at);
  const active = rules.filter((rule) => !rule.expiresAt || Date.parse(rule.expiresAt) > now);
  return incidents.filter((incident) => !active.some((rule) => matchesRule(incident, rule)));
}

export function prioritizeIncidents(incidents: Incident[]): Incident[] {
  const rank: Record<Incident['severity'], number> = { critical: 0, warning: 1, info: 2 };
  return [...incidents].sort((a, b) => rank[a.severity] - rank[b.severity] || a.type.localeCompare(b.type));
}

export function predictBatteryIncidents(
  batteries: BatteryEntity[],
  history: Record<string, BatterySample[]>,
  lowThreshold = 20
): Incident[] {
  return batteries
    .filter((battery) => battery.level <= lowThreshold)
    .map((battery) => {
      const samples = history[historyKey(battery.entityId)] ?? [];
      const previous = samples.at(-1);
      const depletion = previous ? depletionDays(previous, battery) : undefined;
      const confidence = depletion === undefined ? 'low' : 'medium';
      return {
        id: `battery:${battery.entityId}`,
        type: 'battery',
        severity: battery.level <= 10 ? 'critical' : 'warning',
        area: battery.entityId,
        summary: `${battery.name} battery is low (${battery.level}%)`,
        redactedEvidence: [`level=${battery.level}`, `confidence=${confidence}`, depletion ? `estimatedDepletionDays=${depletion}` : 'history=insufficient'],
        detectedAt: battery.observedAt
      } satisfies Incident;
    });
}

function redactText(value: string, report: Set<string>): string {
  let output = value;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match) => {
      report.add(`redacted:${pattern.source}`);
      if (/^(Token|Bearer)\b/i.test(match)) return match.split(/\s+/)[0] + ' [REDACTED]';
      return '[REDACTED]';
    });
  }
  return output;
}

function safeInline(value: string): string {
  const withoutMalformedLinks = value.replace(/\[([^\]]+)]\(([^)]*[\r\n][^)]*)\)/g, '$1');
  const markdownLinkPattern = /\[([^\]\r\n]+)]\(([^)\r\n]+)\)/g;
  let output = '';
  let lastIndex = 0;
  for (const match of withoutMalformedLinks.matchAll(markdownLinkPattern)) {
    output += escapeHtml(withoutMalformedLinks.slice(lastIndex, match.index));
    const [, label = '', url = ''] = match;
    output += isSafeMarkdownUrl(url) ? `[${escapeHtml(label)}](${escapeHtml(url)})` : escapeHtml(label);
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  output += escapeHtml(withoutMalformedLinks.slice(lastIndex));
  return output;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function matchesRule(incident: Incident, rule: IgnoreRuleDto): boolean {
  const match = rule.match.toLowerCase();
  if (rule.type === 'area') return (incident.area ?? '').toLowerCase().includes(match);
  if (rule.type === 'message') return messageHaystack(incident).includes(match);
  if (rule.type && rule.type !== incident.type) return false;
  return `${messageHaystack(incident)} ${incident.area ?? ''}`.toLowerCase().includes(match);
}

function messageHaystack(incident: Incident): string {
  return `${incident.summary} ${incident.redactedEvidence.join(' ')}`.toLowerCase();
}

function sanitizeProviderRecord(value: Record<string, unknown>, report: Set<string>): Record<string, unknown> {
  return sanitizeProviderValue(value, report) as Record<string, unknown>;
}

function sanitizeProviderValue(value: unknown, report: Set<string>, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const redacted = redactText(value, report);
    if (redacted !== value) return redacted;
    report.add('minimized:entityStats:string');
    return '[REDACTED_TEXT]';
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_PROVIDER_DEPTH) {
      report.add('minimized:entityStats:max-depth');
      return '[REDACTED_ARRAY]';
    }
    if (value.length > MAX_PROVIDER_ARRAY_ITEMS) report.add('minimized:entityStats:array-truncated');
    return value.slice(0, MAX_PROVIDER_ARRAY_ITEMS).map((item) => sanitizeProviderValue(item, report, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= MAX_PROVIDER_DEPTH) {
      report.add('minimized:entityStats:max-depth');
      return '[REDACTED_OBJECT]';
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_PROVIDER_OBJECT_KEYS) report.add('minimized:entityStats:object-truncated');
    return Object.fromEntries(
      entries.slice(0, MAX_PROVIDER_OBJECT_KEYS).map(([key, item]) => [
        redactProviderKey(key, report),
        SENSITIVE_KEY_PATTERN.test(key) ? redactSensitiveKeyValue(report) : sanitizeProviderValue(item, report, depth + 1)
      ])
    );
  }
  report.add('minimized:entityStats:unsupported-value');
  return '[REDACTED_VALUE]';
}

function redactSensitiveKeyValue(report: Set<string>): string {
  report.add('redacted:entityStats:sensitive-key');
  return '[REDACTED]';
}

function redactProviderKey(key: string, report: Set<string>): string {
  if (!SENSITIVE_KEY_PATTERN.test(key)) return key;
  report.add('redacted:entityStats:sensitive-key-name');
  return '[REDACTED_KEY]';
}

function isSafeMarkdownUrl(value: string): boolean {
  if (/[\s<>"'`]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function historyKey(entityId: string): string {
  return entityId.replaceAll('.', '_');
}

function depletionDays(previous: BatterySample, current: BatteryEntity): number | undefined {
  const days = (Date.parse(current.observedAt) - Date.parse(previous.at)) / 86_400_000;
  const drop = previous.level - current.level;
  if (days <= 0 || drop <= 0) return undefined;
  return Math.max(1, Math.round(current.level / (drop / days)));
}
