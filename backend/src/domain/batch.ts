import { createHash } from 'node:crypto';
import { sanitizeTraceExcerpt, type SafeTraceExcerpt } from './safe-trace.js';
export type LogLevel = 'ERROR' | 'CRITICAL' | 'WARNING';
export type SignatureClass = 'new' | 'recurring' | 'reactivated' | 'latent';
export type SignatureTrend = 'new' | 'increasing' | 'flat' | 'decreasing' | 'unknown';
export type ProblemKind = 'endpoint_resolution';
export type ParsedLogEntry = {
  at: string;
  level: LogLevel;
  component: string;
  message: string;
  normalizedMessage: string;
  signature: string;
  safeExcerpt?: SafeTraceExcerpt;
  problemKind?: ProblemKind;
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
  problemKind?: ProblemKind;
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
const TIMESTAMPED_LOG_LINE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s+/;
const DEFAULT_LOOKBACK_DAYS = 10;
const DEFAULT_REACTIVATION_DAYS = 7;

export function parseHomeAssistantLog(lines: string[], options: { includeWarnings?: boolean } = {}): ParsedLogEntry[] {
  const entries: ParsedLogEntry[] = [];
  let current: { groups: Record<string, string>; continuation: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const { groups, continuation } = current;
    current = undefined;
    const level = groups.level.toUpperCase() as LogLevel;
    if (level === 'WARNING' && !options.includeWarnings) return;
    const at = toIso(groups.at);
    if (!at) return;
    const component = groups.component.trim().toLowerCase();
    const message = groups.message.trim();
    const normalizedMessage = normalizeLogMessage(message);
    const problemKind = problemKindFor(component, normalizedMessage);
    const safeExcerpt = sanitizeTraceExcerpt(continuation.length > 0 ? continuation : [message]);
    entries.push({ at, level, component, message, normalizedMessage, signature: signatureFor(component, level, normalizedMessage), ...(problemKind ? { problemKind } : {}), ...(safeExcerpt ? { safeExcerpt } : {}) });
  };

  for (const line of lines) {
    if (!TIMESTAMPED_LOG_LINE.test(line)) {
      current?.continuation.push(line);
      continue;
    }
    flush();
    const match = line.match(HA_LOG_LINE);
    if (!match?.groups) continue;
    current = { groups: match.groups as Record<string, string>, continuation: [] };
  }
  flush();
  return entries;
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
      ...(first.problemKind ? { problemKind: first.problemKind } : {}),
      classification,
      trend: trendFor(prior?.previousPeriodCount),
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

function trendFor(previous: number | undefined): SignatureTrend {
  if (previous === undefined) return 'new';
  return 'unknown';
}

function problemKindFor(component: string, normalizedMessage: string): ProblemKind | undefined {
  if (component !== 'homeassistant.components.plex' && !component.startsWith('homeassistant.components.plex.')) return undefined;
  return /(?:name\s*resolution\s*error|nameresolutionerror|failed to resolve|temporary failure in name resolution)/i.test(normalizedMessage)
    ? 'endpoint_resolution'
    : undefined;
}
