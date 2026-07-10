import enResource from './locales/en.json' with { type: 'json' };
import esResource from './locales/es.json' with { type: 'json' };

export const defaultLocale = 'es';

type LocaleShape<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>;
};

const es = esResource;
const en = enResource satisfies LocaleShape<typeof es>;

export const messages = {
  es,
  en,
} as const;

export type Locale = keyof typeof messages;
export type MessageCatalog = typeof es;
export type TranslationKey = LeafPath<MessageCatalog>;

type LeafPath<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafPath<T[K]>}`;
    }[keyof T & string];

export function t(key: TranslationKey): string {
  return tForLocale(defaultLocale, key);
}

export function tForLocale(locale: Locale, key: TranslationKey): string {
  return key.split('.').reduce<unknown>((segment, part) => {
    if (typeof segment !== 'object' || segment === null || !(part in segment)) {
      throw new Error(`Missing translation key: ${locale}.${key}`);
    }

    return (segment as Record<string, unknown>)[part];
  }, messages[locale]) as string;
}
