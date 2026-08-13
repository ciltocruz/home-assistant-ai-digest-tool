export function redactProviderError(value: string, apiKey?: string): string {
  const redacted = apiKey ? value.split(apiKey).join('[REDACTED]') : value;
  return redacted
    .replace(/\bBearer\s+[^\s'"<>,);]+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s'"<>]+/gi, redactUrl)
    .replace(QUERY_SECRET_PATTERN, '$1[REDACTED]')
    .replace(JSON_SECRET_PATTERN, (_match, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]${quote}`)
    .replace(ASSIGNMENT_SECRET_PATTERN, '$1[REDACTED]')
    .replace(TELEGRAM_BOT_PATH_TOKEN_PATTERN, '$1[REDACTED]')
    .replace(TELEGRAM_BOT_TOKEN_PATTERN, '$1[REDACTED]')
    .replace(/\b(?:AIza|sk-|ghp_)[A-Za-z0-9_:-]{8,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]*secret[A-Za-z0-9_:-]*\b/gi, '[REDACTED]');
}

const QUERY_SECRET_PATTERN = /([?&](?:key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|secret|bot[_-]?token)=)[^&#\s]+/gi;
const JSON_SECRET_PATTERN = /((?:\\)?["'](?:key|token|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|authorization|bot[_-]?token)(?:\\)?["']\s*:\s*)((?:\\)?["'])(?:\\.|(?!\2)[^\\\r\n])*\2/gi;
const ASSIGNMENT_SECRET_PATTERN = /(\b(?:key|token|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|authorization|bot[_-]?token)\s*[:=]\s*)[^\s&;,}<>"'`]+/gi;
const TELEGRAM_BOT_PATH_TOKEN_PATTERN = /(\/bot)\d{5,15}:[A-Za-z0-9_-]{8,}(?=[/?#\s;,'"<>]|$)/gi;
const TELEGRAM_BOT_TOKEN_PATTERN = /(\b(?:telegram|telegram\.org|bot|bottoken|sendmessage|send_message)\b[^\n]{0,80}?)\b\d{5,15}:[A-Za-z0-9_-]{8,}\b/gi;

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|password|secret|auth/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch {
    return '[REDACTED_URL]';
  }
}
