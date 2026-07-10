import { describe, expect, test } from 'vitest';
import enResource from './locales/en.json' with { type: 'json' };
import esResource from './locales/es.json' with { type: 'json' };
import { defaultLocale, messages, t, tForLocale } from './index.js';

describe('i18n resources', () => {
  test('uses JSON resources with Spanish as the default locale', () => {
    expect(defaultLocale).toBe('es');
    expect(messages.es).toBe(esResource);
    expect(messages.en).toBe(enResource);
    expect(t('dashboard.manualDigest.copy')).toBe(esResource.dashboard.manualDigest.copy);
  });

  test('looks up the matching English catalog key', () => {
    expect(tForLocale('en', 'dashboard.manualDigest.copy')).toBe(enResource.dashboard.manualDigest.copy);
  });

  test('keeps Spanish and English catalog keys aligned', () => {
    expect(flattenKeys(messages.en)).toEqual(flattenKeys(messages.es));
  });
});

function flattenKeys(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof child === 'string') return [path];
    if (child && typeof child === 'object') return flattenKeys(child as Record<string, unknown>, path);

    throw new Error(`Unsupported translation value at ${path}`);
  }).sort();
}
