import { redactProviderError } from './safe-error.js';

export type SafeTraceExcerpt = {
  lines: string[];
  truncated: boolean;
  redacted: true;
};

const MAX_LINES = 12;
const MAX_LINE_CHARS = 512;
const MAX_BYTES = 4096;
const FILE_LINE = /^\s*File\s+["']([^"']+)["'],\s+line\s+(\d+),\s+in\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const SAFE_FILE_LINE = /^\s*File\s+["']((?:homeassistant\/components|custom_components)\/\[hidden]\/(?:[A-Za-z_][A-Za-z0-9_.-]*\/)*[A-Za-z_][A-Za-z0-9_.-]*)["'],\s+line\s+(\d+),\s+in\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const EXCEPTION_LINE = /^\s*((?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*(?:Error|Exception|Warning|Fault|Timeout))(?::.*)?\s*$/;
const SAFE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function sanitizeTraceExcerpt(value: unknown): SafeTraceExcerpt | undefined {
  const source = sourceLines(value);
  if (!source) return undefined;
  const isTraceback = source.lines.some((line) => /^Traceback \((?:most recent call last|redacted)\):?$/.test(line.trim()));
  const output: string[] = [];
  let truncated = source.truncated;
  let bytes = 0;

  for (const rawLine of source.lines) {
    const safeLine = sanitizeLine(rawLine, isTraceback);
    if (!safeLine) {
      if (rawLine.trim()) truncated = true;
      continue;
    }
    if (output.length >= MAX_LINES) {
      truncated = true;
      break;
    }
    const bounded = safeLine.length > MAX_LINE_CHARS ? safeLine.slice(0, MAX_LINE_CHARS) : safeLine;
    if (bounded.length !== safeLine.length) truncated = true;
    const separatorBytes = output.length === 0 ? 0 : 1;
    const available = MAX_BYTES - bytes - separatorBytes;
    if (available <= 0) {
      truncated = true;
      break;
    }
    const line = truncateUtf8(bounded, available);
    if (!line) {
      truncated = true;
      break;
    }
    if (line !== bounded) truncated = true;
    output.push(line);
    bytes += separatorBytes + Buffer.byteLength(line, 'utf8');
  }

  return output.length > 0 ? { lines: output, truncated, redacted: true } : undefined;
}

function sourceLines(value: unknown): { lines: string[]; truncated: boolean } | undefined {
  if (Array.isArray(value)) {
    return { lines: value.filter((line): line is string => typeof line === 'string'), truncated: false };
  }
  if (!value || typeof value !== 'object') return undefined;
  const excerpt = value as Record<string, unknown>;
  if (!Array.isArray(excerpt.lines)) return undefined;
  return {
    lines: excerpt.lines.filter((line): line is string => typeof line === 'string'),
    truncated: excerpt.truncated === true
  };
}

function sanitizeLine(value: string, isTraceback: boolean): string | undefined {
  const trimmed = value.trim();
  if (/^Traceback \((?:most recent call last|redacted)\):?$/.test(trimmed)) return 'Traceback (redacted)';
  const safeFile = SAFE_FILE_LINE.exec(value);
  if (safeFile && safeIdentifier(safeFile[3])) return `File "${safeFile[1]}", line ${safeFile[2]}, in ${safeFile[3]}`;
  const file = FILE_LINE.exec(value);
  if (file) {
    const path = safeModulePath(file[1] ?? '');
    if (!path || !safeIdentifier(file[3])) return undefined;
    return `File "${path}", line ${file[2]}, in ${file[3]}`;
  }
  const exception = EXCEPTION_LINE.exec(value);
  if (exception?.[1]) return exception[1];
  if (isTraceback) return undefined;

  const redacted = redactProviderError(trimmed);
  return redacted.length > 0 ? redacted : undefined;
}

function safeIdentifier(value: string | undefined): value is string {
  return typeof value === 'string' && !/[A-Za-z0-9]{12,}/.test(value);
}

function safeModulePath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/');
  const componentMarker = normalized.lastIndexOf('/homeassistant/components/');
  if (componentMarker >= 0) return hideComponentPath(normalized.slice(componentMarker + 1), 'homeassistant/components');
  const customMarker = normalized.lastIndexOf('/custom_components/');
  if (customMarker >= 0) return hideComponentPath(normalized.slice(customMarker + 1), 'custom_components');
  const packageMarker = normalized.lastIndexOf('/site-packages/');
  if (packageMarker >= 0) return validateRelativePath(normalized.slice(packageMarker + '/site-packages/'.length));
  return undefined;
}

function hideComponentPath(value: string, prefix: 'homeassistant/components' | 'custom_components'): string | undefined {
  const segments = value.split('/');
  const prefixLength = prefix.split('/').length;
  const remainder = segments.slice(prefixLength + 1);
  const safeRemainder = validateSegments(remainder);
  return safeRemainder ? `${prefix}/[hidden]/${safeRemainder}` : undefined;
}

function validateRelativePath(value: string): string | undefined {
  return validateSegments(value.split('/'));
}

function validateSegments(segments: string[]): string | undefined {
  if (segments.length === 0 || segments.length > 16 || segments.some((segment) => !SAFE_SEGMENT.test(segment) || /[A-Za-z0-9]{12,}/.test(segment))) return undefined;
  return segments.join('/');
}

function truncateUtf8(value: string, maxBytes: number): string {
  let output = '';
  for (const character of value) {
    if (Buffer.byteLength(output + character, 'utf8') > maxBytes) break;
    output += character;
  }
  return output;
}
