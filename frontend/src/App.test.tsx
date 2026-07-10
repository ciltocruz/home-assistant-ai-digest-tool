import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { App } from './App.js';

describe('App', () => {
  test('renders a product-specific onboarding shell with privacy-aware setup steps', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('Home Assistant AI Digest');
    expect(html).toContain('Connect Home Assistant');
    expect(html).toContain('Choose AI provider');
    expect(html).toContain('Set privacy level');
    expect(html).toContain('Run first digest');
    expect(html).toContain('Secrets are sent only to the local backend and displayed as masks after validation.');
  });

  test('renders useful dashboard, history, notes, ignores, settings, and Telegram test-send states', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('Manual digest');
    expect(html).toContain('No digests yet');
    expect(html).toContain('Add a note');
    expect(html).toContain('Ignored warnings');
    expect(html).toContain('Telegram test-send');
    expect(html).toContain('Daily schedule');
  });
});
