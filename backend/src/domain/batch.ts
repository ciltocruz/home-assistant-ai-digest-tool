import { createHash } from 'node:crypto';
export type LogLevel = 'ERROR' | 'CRITICAL' | 'WARNING';
export type SignatureClass = 'new' | 'recurring' | 'reactivated' | 'latent';
export type SignatureTrend = 'new' | 'increasing' | 'flat' | 'decreasing';
export type ParsedLogEntry = {
  at: string;
  level: LogLevel;
  component: string;
  message: string;
  normalizedMessage: string;
  signature: string;
};
export type LogCursor = { dev: number; ino: number; size: number; offset: number };
export type LogDelta = { lines: string[]; cursor: LogCursor; recovery?: 'truncated' | 'replaced' };
export type KnownSignature = {
  signature: string;
  firstSeenAt: string;
  lastSeenAt: string;
  previousPeriodCount: number;
};

export type BatchSignature = {
  signature: string;
  component: string;
  level: LogLevel;
  normalizedMessage: string;
  classification: SignatureClass;
  trend: SignatureTrend;
  occurrences: ParsedLogEntry[];
};

export type SignaturePlan = {
  signatures: BatchSignature[];
  baselineEntries: ParsedLogEntry[];
};

export type BatchClassificationOptions = {
  now: string;
  lookbackDays?: number;
  reactivationDays?: number;
};

const HA_LOG_LINE = /^(?<at>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(?<level>ERROR|CRITICAL|WARNING)\s+(?:\([^)]*\)\s+)?\[(?<component>[^\]]+)]\s*(?<message>[\s\S]+)$/i;
const DEFAULT_LOOKBACK_DAYS = 10;
const DEFAULT_REACTIVATION_DAYS = 7;

export function parseHomeAssistantLog(lines: string[], options: { includeWarnings?: boolean } = {}): ParsedLogEntry[] {
  return lines.flatMap((line) => {
    const match = line.match(HA_LOG_LINE);
    if (!match?.groups) return [];
    const level = match.groups.level.toUpperCase() as LogLevel;
    if (level === 'WARNING' && !options.includeWarnings) return [];
    const at = toIso(match.groups.at);
    if (!at) return [];
    const component = match.groups.component.trim().toLowerCase();
    const message = match.groups.message.trim();
    const normalizedMessage = normalizeLogMessage(message);
    return [{ at, level, component, message, normalizedMessage, signature: signatureFor(component, level, normalizedMessage) }];
  });
}

export function normalizeLogMessage(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\b(?:0x)?[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b(?:id|entry_id|line)\s*[=:]?\s*\d+\b/gi, (value) => value.replace(/\d+$/, '<number>'))
    .replace(/\b\d{2,}\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function classifySignatures(entries: ParsedLogEntry[], known: KnownSignature[], options: BatchClassificationOptions): SignaturePlan {
  const now = Date.parse(options.now);
  const lookbackAt = now - (options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 86_400_000;
  const reactivationAt = now - (options.reactivationDays ?? DEFAULT_REACTIVATION_DAYS) * 86_400_000;
  const knownBySignature = new Map(known.map((item) => [item.signature, item]));
  const bySignature = new Map<string, ParsedLogEntry[]>();
  for (const entry of entries) bySignature.set(entry.signature, [...(bySignature.get(entry.signature) ?? []), entry]);

  const baselineEntries = entries.filter((entry) => Date.parse(entry.at) < lookbackAt);
  const signatures = [...bySignature.values()].flatMap((occurrences) => {
    const inWindow = occurrences.filter((entry) => Date.parse(entry.at) >= lookbackAt);
    if (inWindow.length === 0) return [];
    const first = inWindow[0]!;
    const prior = knownBySignature.get(first.signature);
    const hasHistoricalOccurrence = occurrences.some((entry) => Date.parse(entry.at) < lookbackAt);
    const classification: SignatureClass = !prior
      ? hasHistoricalOccurrence ? 'latent' : 'new'
      : Date.parse(prior.firstSeenAt) < lookbackAt || hasHistoricalOccurrence ? 'latent'
        : Date.parse(prior.lastSeenAt) < reactivationAt ? 'reactivated'
          : 'recurring';
    return [{
      signature: first.signature,
      component: first.component,
      level: first.level,
      normalizedMessage: first.normalizedMessage,
      classification,
      trend: trendFor(inWindow.length, prior?.previousPeriodCount),
      occurrences: inWindow
    }];
  });
  return { signatures, baselineEntries };
}

function signatureFor(component: string, level: LogLevel, normalizedMessage: string): string {
  return createHash('sha256').update(`${component}\u0000${level}\u0000${normalizedMessage}`).digest('hex').slice(0, 24);
}

function toIso(value: string): string | null {
  const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function trendFor(current: number, previous: number | undefined): SignatureTrend {
  if (previous === undefined) return 'new';
  if (current > previous) return 'increasing';
  if (current < previous) return 'decreasing';
  return 'flat';
}
