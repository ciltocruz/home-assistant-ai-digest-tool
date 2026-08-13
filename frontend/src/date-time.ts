import { currentLocale, type Locale } from './i18n/index.js';

export function formatDateTime(value: string, timeZone?: string, locale: Locale = currentLocale()): string {
  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(validTimeZone(timeZone) ? { timeZone } : {})
  };
  return new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-GB', options).format(new Date(value)).replace('.', '');
}

function validTimeZone(timeZone?: string): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}
